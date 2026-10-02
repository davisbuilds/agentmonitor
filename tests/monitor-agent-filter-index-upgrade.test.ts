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
  db.exec('DROP INDEX idx_events_agent_tool_order; DROP INDEX idx_events_agent_event_covering; DROP INDEX idx_events_agent_created_order; PRAGMA user_version = 10');

  schema.ensureSchemaForRead();

  const present = db.prepare(`SELECT name FROM sqlite_master
    WHERE name IN ('idx_events_agent_tool_order', 'idx_events_agent_event_covering', 'idx_events_agent_created_order') ORDER BY name`).all();
  assert.deepEqual(present, [
    { name: 'idx_events_agent_created_order' }, { name: 'idx_events_agent_event_covering' }, { name: 'idx_events_agent_tool_order' },
  ]);
  assert.equal(db.pragma('user_version', { simple: true }), 13);
});

test('a read-only command replaces the v11 agent+event-type index with the covering one', async () => {
  const connection = await import('../src/db/connection.js');
  const schema = await import('../src/db/schema.js');
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  // v11 shipped this index without source, so the page's total count looked up
  // every matching row to apply the benchmark exclusion.
  db.exec(`DROP INDEX idx_events_agent_event_covering;
    CREATE INDEX idx_events_agent_event_order ON events(agent_type, event_type, datetime(created_at) DESC, id DESC);
    PRAGMA user_version = 11`);

  schema.ensureSchemaForRead();

  const names = db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'idx_events_agent_event%' ORDER BY name`).all();
  assert.deepEqual(names, [{ name: 'idx_events_agent_event_covering' }]);
  assert.equal(db.pragma('user_version', { simple: true }), 13);
});

test('a read-only command installs the session-window index on a v12 database', async () => {
  const connection = await import('../src/db/connection.js');
  const schema = await import('../src/db/schema.js');
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  db.exec('DROP INDEX idx_events_session_window; PRAGMA user_version = 12');

  schema.ensureSchemaForRead();

  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_events_session_window'`).all(), [{ name: 'idx_events_session_window' }]);
  assert.equal(db.pragma('user_version', { simple: true }), 13);
});
