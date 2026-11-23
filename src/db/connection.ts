import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { resolveDbPath } from '../db-path.js';

let db: Database.Database | undefined;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Under the test runner, refuse to open the install database.
 *
 * Tests point AGENTMONITOR_DB_PATH at a temp file, but config.ts snapshots the
 * environment when it is imported. A test that pulls it in too early — or that
 * forgets the variable entirely — silently falls back to the install default and
 * reads and writes the developer's real data while still reporting green. That
 * has already happened once. There is no case where a test should open the real
 * database, so make it an immediate, legible failure rather than a quiet one.
 */
export function assertTestDbIsIsolated(dbPath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.NODE_TEST_CONTEXT) return;
  if (path.resolve(dbPath) !== path.resolve(resolveDbPath({}))) return;

  throw new Error(
    `Refusing to open the install database from a test: ${dbPath}\n`
    + 'Set AGENTMONITOR_DB_PATH to a temp file before importing any module that reads config.',
  );
}

export function getDb({ fileMustExist = false } = {}): Database.Database {
  if (!db) {
    assertTestDbIsIsolated(config.dbPath);
    const dbDir = path.dirname(config.dbPath);
    if (!fileMustExist && !fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(config.dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS, fileMustExist });
    // WHY: A short-lived CLI can encounter an existing writer even while setting pragmas; install
    // the busy handler first.
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    const journalMode = db.pragma('journal_mode', { simple: true });
    if (journalMode !== 'wal') db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -64000');
    // WHY: SQLite retains a reset WAL at its high-water mark unless a size limit is set.
    db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
