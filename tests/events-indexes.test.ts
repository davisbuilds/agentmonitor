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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-events-indexes-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'events-indexes.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();

  // Seed a few events so query plans have something to resolve against.
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO events (event_id, session_id, agent_type, event_type, tool_name, created_at, model, tokens_in, tokens_out, cost_usd)
     VALUES (?, ?, 'claude', 'tool_use', 'Edit', ?, 'claude-opus-4-8', 10, 20, 0.01)`,
  );
  for (let i = 0; i < 50; i++) {
    insert.run(`evt-${i}`, `session-${i % 5}`, `2026-05-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`);
  }
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function indexNames(): Set<string> {
  return new Set(
    (getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as Array<{ name: string }>).map(
      r => r.name,
    ),
  );
}

function queryPlan(sql: string, ...params: unknown[]): string {
  return (getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map(r => r.detail)
    .join(' | ');
}

test('the redundant bare session_id index is dropped (superseded by composite)', () => {
  const names = indexNames();
  assert.equal(names.has('idx_events_session_id'), false, 'bare idx_events_session_id should be superseded');
});

test('filter-option enumeration indexes are retained', () => {
  // Low-cardinality, so useless for row filtering, but they cover the
  // `SELECT DISTINCT agent_type/event_type ... ORDER BY` filter-option reads.
  const names = indexNames();
  assert.ok(names.has('idx_events_agent_type'), 'idx_events_agent_type should be retained for DISTINCT enumeration');
  assert.ok(names.has('idx_events_event_type'), 'idx_events_event_type should be retained for DISTINCT enumeration');
});

test('filter-option DISTINCT enumeration uses a covering index (no temp b-tree)', () => {
  const plan = queryPlan('SELECT DISTINCT agent_type FROM events WHERE agent_type IS NOT NULL ORDER BY agent_type');
  assert.match(plan, /COVERING INDEX idx_events_agent_type/, `expected covering index, got: ${plan}`);
  assert.doesNotMatch(plan, /TEMP B-TREE/, `expected no temp b-tree, got: ${plan}`);
});

test('covering composite event indexes exist', () => {
  const names = indexNames();
  assert.ok(names.has('idx_events_session_cost'), 'idx_events_session_cost should exist');
  assert.ok(names.has('idx_events_created_model'), 'idx_events_created_model should exist');
  assert.ok(names.has('idx_events_created_at'), 'idx_events_created_at should remain');
  assert.ok(names.has('idx_events_tool_name'), 'idx_events_tool_name should remain');
});

test('per-session SUM subquery uses the covering session index', () => {
  const plan = queryPlan('SELECT SUM(tokens_in), SUM(tokens_out), SUM(cost_usd) FROM events WHERE session_id = ?', 'session-1');
  assert.match(plan, /idx_events_session_cost/, `expected covering session index, got: ${plan}`);
});

test('time-windowed cost aggregate uses the covering created/model index', () => {
  const plan = queryPlan(
    `SELECT date(created_at) d, model, SUM(tokens_in), SUM(cost_usd) FROM events WHERE created_at >= ? GROUP BY d, model`,
    '2026-05-01',
  );
  assert.match(plan, /idx_events_created_model/, `expected covering created/model index, got: ${plan}`);
});
