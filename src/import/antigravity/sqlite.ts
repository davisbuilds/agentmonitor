import fs from 'node:fs';
import Database from 'better-sqlite3';

export interface SqliteReadRetryOptions {
  retryDelaysMs?: readonly number[];
  busyTimeoutMs?: number;
  throwOnError?: boolean;
}

const DEFAULT_RETRY_DELAYS_MS = [15, 30, 60, 120, 240] as const;

const RETRYABLE_SQLITE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_IOERR',
  'SQLITE_IOERR_SHORT_READ',
  'SQLITE_IOERR_LOCK',
  'SQLITE_IOERR_SHMSIZE',
  'SQLITE_PROTOCOL',
  'EBUSY',
  'EAGAIN',
]);

export function isRetryableSqliteError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && RETRYABLE_SQLITE_CODES.has(code)) return true;
  const message = 'message' in err && typeof (err as { message?: unknown }).message === 'string'
    ? (err as { message: string }).message.toLowerCase()
    : '';
  return message.includes('database is locked') || message.includes('database is busy');
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openReadOnlySqliteWithRetry<T>(
  dbPath: string,
  reader: (db: Database.Database) => T,
  options?: SqliteReadRetryOptions,
): T | null {
  if (!fs.existsSync(dbPath)) return null;

  const delays = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const busyTimeoutMs = options?.busyTimeoutMs ?? 50;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
      db.pragma('query_only = ON');
      return reader(db);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
      if (code === 'ENOENT') return null;
      if (isRetryableSqliteError(err) && attempt < delays.length) {
        sleepSync(delays[attempt]);
        continue;
      }
      throw err;
    } finally {
      try {
        db?.close();
      } catch {
        // WHY: Ignore secondary errors closing a failed read-only SQLite handle.
      }
    }
  }

  return null;
}
