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
  assert.ok(names.has('idx_events_session_reconcile'), 'idx_events_session_reconcile should exist');
  assert.ok(
    names.has('idx_events_codex_import_usage_session_ts'),
    'idx_events_codex_import_usage_session_ts should exist',
  );
  assert.ok(names.has('idx_events_usage_covering'), 'idx_events_usage_covering should exist');
  assert.ok(names.has('idx_events_benchmark_monitor'), 'idx_events_benchmark_monitor should exist');
  assert.ok(names.has('idx_events_created_at_order'), 'idx_events_created_at_order should exist');
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

test('event-session reconciliation uses the dedicated composite index', () => {
  const plan = queryPlan(
    `SELECT id FROM events
     WHERE session_id = ? AND agent_type = 'codex' AND source = 'import'`,
    'session-1',
  );
  assert.match(
    plan,
    /idx_events_session_reconcile/,
    `expected event-session reconciliation index, got: ${plan}`,
  );
});

test('Codex usage reconciliation seeks imported rows by session and normalized timestamp', () => {
  const plan = queryPlan(
    `SELECT id FROM events imported_usage
     WHERE imported_usage.session_id = ?
       AND imported_usage.agent_type = 'codex'
       AND imported_usage.source = 'import'
       AND (
         COALESCE(imported_usage.cost_usd, 0) > 0
         OR COALESCE(imported_usage.tokens_in, 0) > 0
         OR COALESCE(imported_usage.tokens_out, 0) > 0
         OR COALESCE(imported_usage.cache_read_tokens, 0) > 0
         OR COALESCE(imported_usage.cache_write_tokens, 0) > 0
       )
       AND datetime(COALESCE(imported_usage.client_timestamp, imported_usage.created_at)) >= ?`,
    'session-1',
    '2026-05-01',
  );
  assert.match(
    plan,
    /idx_events_codex_import_usage_session_ts \(session_id=\? AND <expr>>\?\)/,
    `expected a session+timestamp range seek, got: ${plan}`,
  );
});

test('recent Monitor events stream from the normalized created-at order index', () => {
  const plan = queryPlan(
    `SELECT * FROM events
     WHERE source IS NULL OR source != 'benchmark'
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ?`,
    100,
  );
  assert.match(plan, /idx_events_created_at_order/, `expected normalized order index, got: ${plan}`);
  assert.doesNotMatch(plan, /TEMP B-TREE/, `expected no temporary ordering b-tree, got: ${plan}`);
});

test('Monitor usage totals scan the metric-only covering index', () => {
  const plan = queryPlan(
    `SELECT SUM(e.tokens_in), SUM(e.tokens_out), SUM(e.cost_usd)
     FROM events e
     WHERE (e.source IS NULL OR e.source != 'benchmark')
       AND (
         COALESCE(e.cost_usd, 0) > 0
         OR COALESCE(e.tokens_in, 0) > 0
         OR COALESCE(e.tokens_out, 0) > 0
         OR COALESCE(e.cache_read_tokens, 0) > 0
         OR COALESCE(e.cache_write_tokens, 0) > 0
       )`,
  );
  assert.match(plan, /COVERING INDEX idx_events_usage_covering/, `expected Monitor usage covering index, got: ${plan}`);
});

test('Usage row selection range-seeks the metric-only covering index', () => {
  const plan = queryPlan(
    `SELECT
       e.session_id,
       COALESCE(NULLIF(e.source, ''), 'api') as source,
       COALESCE(NULLIF(e.project, ''), 'unknown') as project,
       e.agent_type,
       COALESCE(NULLIF(e.model, ''), 'unknown') as model,
       COALESCE(e.cost_usd, 0) as cost_usd,
       COALESCE(e.tokens_in, 0) as tokens_in,
       COALESCE(e.tokens_out, 0) as tokens_out,
       COALESCE(e.cache_read_tokens, 0) as cache_read_tokens,
       COALESCE(e.cache_write_tokens, 0) as cache_write_tokens,
       COALESCE(e.client_timestamp, e.created_at) as timestamp
     FROM events e
     WHERE datetime(COALESCE(e.client_timestamp, e.created_at)) >= datetime(?)
       AND (e.source IS NULL OR e.source != 'benchmark')
       AND (
         COALESCE(e.cost_usd, 0) > 0
         OR COALESCE(e.tokens_in, 0) > 0
         OR COALESCE(e.tokens_out, 0) > 0
         OR COALESCE(e.cache_read_tokens, 0) > 0
         OR COALESCE(e.cache_write_tokens, 0) > 0
       )`,
    '2026-07-13',
  );
  assert.match(
    plan,
    /SEARCH e USING COVERING INDEX idx_events_usage_covering \(<expr>>\?\)/,
    `expected Usage timestamp range seek on the covering index, got: ${plan}`,
  );
});

test('benchmark subtraction seeks the benchmark-only Monitor index', () => {
  const plan = queryPlan(
    `SELECT session_id, agent_type, tool_name, model
     FROM events
     WHERE source = 'benchmark'`,
  );
  assert.match(plan, /COVERING INDEX idx_events_benchmark_monitor/, `expected benchmark Monitor index, got: ${plan}`);
});
