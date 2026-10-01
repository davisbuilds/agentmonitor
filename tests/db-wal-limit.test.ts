import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-wal-limit-'));
process.env.AGENTMONITOR_DB_PATH = path.join(dir, 'test.db');
let closeDb: (() => void) | undefined;

after(() => {
  closeDb?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('connections cap the WAL file a checkpoint leaves behind', async () => {
  // Without a limit SQLite keeps the WAL at its largest size forever: a store
  // held a 392 MB WAL long after the write burst that grew it.
  const connection = await import('../src/db/connection.js');
  closeDb = connection.closeDb;
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  assert.equal(db.pragma('journal_size_limit', { simple: true }), 64 * 1024 * 1024);
});
