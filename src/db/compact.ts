import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { acquireRuntimeOwnership } from '../runtime-ownership.js';
import { createValidatedDatabaseBackup } from './backup.js';
import { readStorageReport, type StorageReport } from './storage.js';

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

export class DatabaseCompactPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCompactPolicyError';
  }
}

export interface DatabaseCompactResult {
  status: 'ok';
  backup: string;
  before: StorageReport;
  after: StorageReport;
  quick_check: 'ok';
}

export interface DatabaseCompactOptions {
  source: string;
  /** Absolute path for the validated backup taken before anything is rewritten. */
  backup: string;
  /** Free bytes on the volume holding `directory`; injectable for tests. */
  availableBytes?: (directory: string) => number;
}

function freeBytes(directory: string): number {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
}

function deviceOf(directory: string): number | undefined {
  try {
    return fs.statSync(directory).dev;
  } catch {
    return undefined; // the backup's own checks report a missing directory
  }
}

/**
 * Rewrite the store without its free pages and dead search-index entries.
 *
 * Holds runtime ownership throughout, so it refuses while a server runs and a
 * server cannot start mid-way. Nothing is rewritten until a validated backup of
 * the current store exists. VACUUM builds the compacted copy in a temporary
 * file and then writes it back through the WAL, so the store's volume needs up
 * to twice the current size free, plus the backup when it shares the volume;
 * the backup's own volume needs room for it in any case.
 */
export async function compactDatabase(options: DatabaseCompactOptions): Promise<DatabaseCompactResult> {
  const source = fs.realpathSync(path.resolve(options.source));
  const ownership = acquireRuntimeOwnership(source);
  try {
    const db = new Database(source, { fileMustExist: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      const before = readStorageReport(db);
      const current = before.database_bytes + before.wal_bytes;
      const storeDir = path.dirname(source);
      const backupDir = path.dirname(path.resolve(options.backup));
      const shared = deviceOf(backupDir) === undefined || deviceOf(backupDir) === deviceOf(storeDir);
      const availableBytes = options.availableBytes ?? freeBytes;
      const needed = current * 2 + (shared ? current : 0);
      const available = availableBytes(storeDir);
      if (available < needed) {
        throw new DatabaseCompactPolicyError(
          `Not enough free space: compact needs about ${needed} bytes on the store's volume `
          + `(the rewrite${shared ? ' and the backup' : ''}) and ${available} are free.`,
        );
      }
      const backupAvailable = availableBytes(backupDir);
      if (backupAvailable < current) {
        throw new DatabaseCompactPolicyError(
          `Not enough free space for the backup: it needs about ${current} bytes and ${backupAvailable} are free.`,
        );
      }

      const backup = await createValidatedDatabaseBackup({ source, output: options.backup, replace: false });

      // The server is stopped, so a blocking optimize is fine, and unlike the
      // server's capped stepwise merge it always finishes.
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
      db.exec('VACUUM');
      // Fold the rewrite back into the main file and drop the WAL it filled.
      db.pragma('wal_checkpoint(TRUNCATE)');
      const quickCheck = db.pragma('quick_check', { simple: true });
      if (quickCheck !== 'ok') throw new Error(`quick_check after VACUUM reported: ${String(quickCheck)}`);

      return {
        status: 'ok',
        backup: backup.output,
        before,
        after: readStorageReport(db),
        quick_check: 'ok',
      };
    } finally {
      db.close();
    }
  } finally {
    ownership.release();
  }
}
