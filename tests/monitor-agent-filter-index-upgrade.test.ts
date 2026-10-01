import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

let dir = '';
let closeDb: (() => void) | undefined;

after(() => {
  closeDb?.();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('a read-only command installs the agent-filter indexes on a database from before them', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agent-index-upgrade-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(dir, 'test.db');
  const connection = await import('../src/db/connection.js');
  closeDb = connection.closeDb;
  const schema = await import('../src/db/schema.js');
  schema.initSchema();
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  // The preceding schema: read commands skip DDL once user_version is current,
  // so the indexes only arrive if the version moves past it.
  db.exec('DROP INDEX idx_events_agent_dims; DROP INDEX idx_events_agent_created_order; PRAGMA user_version = 10');

  schema.ensureSchemaForRead();

  const present = db.prepare(`SELECT name FROM sqlite_master
    WHERE name IN ('idx_events_agent_dims', 'idx_events_agent_created_order') ORDER BY name`).all();
  assert.deepEqual(present, [{ name: 'idx_events_agent_created_order' }, { name: 'idx_events_agent_dims' }]);
  assert.equal(db.pragma('user_version', { simple: true }), 11);
});
