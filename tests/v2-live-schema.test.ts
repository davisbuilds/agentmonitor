import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-live-schema-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const schemaModule = await import('../src/db/schema.js');
  initSchema = schemaModule.initSchema;

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('browsing_sessions includes live metadata columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(browsing_sessions)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('live_status'));
  assert.ok(colNames.includes('last_item_at'));
  assert.ok(colNames.includes('integration_mode'));
  assert.ok(colNames.includes('fidelity'));
});

test('session_turns table exists with expected columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(session_turns)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.deepEqual(
    ['id', 'session_id', 'agent_type', 'source_turn_id', 'status', 'title', 'started_at', 'ended_at', 'created_at'],
    colNames,
  );
});

test('session_items table exists with expected columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(session_items)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.deepEqual(
    ['id', 'session_id', 'turn_id', 'ordinal', 'source_item_id', 'kind', 'status', 'payload_json', 'created_at'],
    colNames,
  );
});

test('live schema tables accept inserts and query ordering works', () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, live_status, last_item_at, integration_mode, fidelity
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('live-sess-001', 'agentmonitor', 'claude', 'live', '2026-03-23T12:00:03Z', 'claude-jsonl', 'full');

  const turnResult = db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('live-sess-001', 'claude', 'turn-001', 'completed', 'Inspect repo', '2026-03-23T12:00:00Z', '2026-03-23T12:00:03Z');

  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('live-sess-001', turnResult.lastInsertRowid, 0, 'item-001', 'user_message', 'success', '{"text":"Inspect the repo"}', '2026-03-23T12:00:00Z');

  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('live-sess-001', turnResult.lastInsertRowid, 1, 'item-002', 'reasoning', 'success', '{"text":"Reading files"}', '2026-03-23T12:00:01Z');

  const turns = db.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY started_at DESC').all('live-sess-001') as Array<{ source_turn_id: string }>;
  const items = db.prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY ordinal').all('live-sess-001') as Array<{ kind: string }>;

  assert.equal(turns.length, 1);
  assert.equal(turns[0].source_turn_id, 'turn-001');
  assert.deepEqual(items.map(item => item.kind), ['user_message', 'reasoning']);
});

test('live schema indexes exist', () => {
  const db = getDb();
  const turnIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_turns'").all() as Array<{ name: string }>;
  const itemIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_items'").all() as Array<{ name: string }>;
  const sessionIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='browsing_sessions'").all() as Array<{ name: string }>;

  assert.ok(turnIndexes.some(index => index.name.includes('session_started_at')));
  assert.ok(itemIndexes.some(index => index.name.includes('session_created_at')));
  assert.ok(itemIndexes.some(index => index.name.includes('turn_ordinal')));
  assert.ok(sessionIndexes.some(index => index.name.includes('last_item_at')));
  assert.ok(sessionIndexes.some(index => index.name.includes('live_status')));
});

test('legacy browsing_sessions databases receive live metadata columns', async () => {
  closeDb();

  const legacyDbPath = path.join(tempDir, 'legacy.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE browsing_sessions (
      id TEXT PRIMARY KEY,
      project TEXT,
      agent TEXT NOT NULL,
      first_message TEXT,
      started_at TEXT,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      user_message_count INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      relationship_type TEXT,
      file_path TEXT,
      file_size INTEGER,
      file_hash TEXT
    );
  `);
  legacyDb.close();

  process.env.AGENTMONITOR_DB_PATH = legacyDbPath;
  const schemaModule = await import('../src/db/schema.js');
  schemaModule.initSchema();

  const dbModule = await import('../src/db/connection.js');
  const db = dbModule.getDb();
  const columns = db.prepare("PRAGMA table_info(browsing_sessions)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('live_status'));
  assert.ok(colNames.includes('last_item_at'));
  assert.ok(colNames.includes('integration_mode'));
  assert.ok(colNames.includes('fidelity'));
});

test('initSchema succeeds against a legacy browsing_sessions database on process startup', () => {
  const startupDbPath = path.join(tempDir, 'legacy-startup.db');
  const startupDb = new Database(startupDbPath);
  startupDb.exec(`
    CREATE TABLE browsing_sessions (
      id TEXT PRIMARY KEY,
      project TEXT,
      agent TEXT NOT NULL,
      first_message TEXT,
      started_at TEXT,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      user_message_count INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      relationship_type TEXT,
      file_path TEXT,
      file_size INTEGER,
      file_hash TEXT
    );
  `);
  startupDb.close();

  execFileSync('node', [
    '--import', 'tsx',
    '--eval',
    "const schema = await import('./src/db/schema.ts'); schema.initSchema();",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTMONITOR_DB_PATH: startupDbPath,
    },
    stdio: 'pipe',
  });

  const verified = new Database(startupDbPath);
  const columns = verified.prepare("PRAGMA table_info(browsing_sessions)").all() as Array<{ name: string }>;
  verified.close();

  const colNames = columns.map(c => c.name);
  assert.ok(colNames.includes('live_status'));
  assert.ok(colNames.includes('last_item_at'));
  assert.ok(colNames.includes('integration_mode'));
  assert.ok(colNames.includes('fidelity'));
});
