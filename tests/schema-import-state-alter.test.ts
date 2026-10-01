import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-import-state-alter-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'legacy.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('initSchema adds file_mtime to an import_state table that predates it, keeping its rows', () => {
  const db = getDb();
  assert.equal(db.name, path.join(tempDir, 'legacy.db'));
  db.exec(`
    CREATE TABLE import_state (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      source TEXT NOT NULL,
      events_imported INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO import_state (file_path, file_hash, file_size, source)
    VALUES ('/logs/a.jsonl', 'abc', 10, 'claude-code');
  `);

  initSchema();

  const row = db.prepare('SELECT file_hash, file_size, file_mtime FROM import_state WHERE file_path = ?')
    .get('/logs/a.jsonl');
  // No stamp yet, so the next import reads the file once and records one.
  assert.deepEqual({ ...(row as object) }, { file_hash: 'abc', file_size: 10, file_mtime: null });
});
