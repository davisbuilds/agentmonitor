import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { getDb as getDbType, closeDb as closeDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';
import type {
  backfillSessionTraceSummaries as backfillType,
  sessionTraceId as sessionTraceIdType,
} from '../src/trace-quality/summary.js';
import type {
  getSessionTraceDetail as getDetailType,
  listSessionObservations as listObservationsType,
  listSessionTraces as listTracesType,
} from '../src/trace-quality/on-demand.js';

let tempDir = '';
let getDb: typeof getDbType;
let closeDb: typeof closeDbType;
let initSchema: typeof initSchemaType;
let backfillSessionTraceSummaries: typeof backfillType;
let sessionTraceId: typeof sessionTraceIdType;
let listSessionTraces: typeof listTracesType;
let getSessionTraceDetail: typeof getDetailType;
let listSessionObservations: typeof listObservationsType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-tq-ondemand-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'tq-ondemand.db');

  initSchema = (await import('../src/db/schema.js')).initSchema;
  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const summary = await import('../src/trace-quality/summary.js');
  backfillSessionTraceSummaries = summary.backfillSessionTraceSummaries;
  sessionTraceId = summary.sessionTraceId;
  const onDemand = await import('../src/trace-quality/on-demand.js');
  listSessionTraces = onDemand.listSessionTraces;
  getSessionTraceDetail = onDemand.getSessionTraceDetail;
  listSessionObservations = onDemand.listSessionObservations;

  initSchema();
  seed();
  backfillSessionTraceSummaries();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seed(): void {
  const db = getDb();
  const session = db.prepare(
    `INSERT INTO sessions (id, agent_id, agent_type, status, last_event_at) VALUES (?, ?, ?, 'ended', ?)`,
  );
  session.run('s-events', 'a1', 'claude', '2026-05-01T10:00:00Z');
  session.run('s-events2', 'a1', 'codex', '2026-05-01T10:30:00Z');

  const event = db.prepare(
    `INSERT INTO events (id, event_id, session_id, agent_type, event_type, tool_name, status, model,
       tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  event.run(1, 'e1', 's-events', 'claude', 'tool_use', 'Edit', 'success', 'claude-opus-4-8', 100, 50, 10, 5, 0.01, 1200, '2026-05-01T10:00:00Z');
  event.run(2, 'e2', 's-events', 'claude', 'tool_use', 'Bash', 'error', 'claude-opus-4-8', 200, 0, 0, 0, 0.02, 800, '2026-05-01T10:01:00Z');
  event.run(3, 'e3', 's-events', 'claude', 'response', null, 'success', 'claude-opus-4-8', 50, 300, 0, 0, 0.03, null, '2026-05-01T10:02:00Z');
  event.run(4, 'e4', 's-events2', 'codex', 'tool_use', 'apply_patch', 'success', 'gpt-5', 80, 40, 0, 0, 0.04, 500, '2026-05-01T10:30:00Z');
  event.run(5, 'e5', 's-events2', 'codex', 'response', null, 'success', 'gpt-5', 20, 90, 0, 0, 0.05, 300, '2026-05-01T10:31:00Z');
}

test('list emits one row per session from the summary, keyed by a stable trace_id', () => {
  const result = listSessionTraces({});
  assert.equal(result.total, 2, 'two event-bearing sessions => two rows (not one-per-event)');
  assert.equal(result.data.length, 2);
  for (const trace of result.data) {
    assert.ok(trace.id, 'each row carries a trace id');
    assert.equal(trace.id, sessionTraceId(trace.session_id), 'id is the deterministic per-session trace id');
  }
  const sEvents = result.data.find(t => t.session_id === 's-events');
  assert.ok(sEvents);
  assert.equal(sEvents.aggregate.observation_count, 3, 'aggregate reflects the 3 events as observations');
  assert.equal(sEvents.aggregate.total_tokens_in, 350);
  assert.equal(sEvents.agent_type, 'claude');
});

test('list honors the session_id filter (drill-in path)', () => {
  const result = listSessionTraces({ session_id: 's-events2' });
  assert.equal(result.total, 1);
  assert.equal(result.data[0]!.session_id, 's-events2');
  assert.equal(result.data[0]!.id, sessionTraceId('s-events2'));
});

test('detail resolves a trace_id back to its session', () => {
  const traceId = sessionTraceId('s-events');
  const detail = getSessionTraceDetail(traceId);
  assert.ok(detail);
  assert.equal(detail.trace.id, traceId);
  assert.equal(detail.trace.session_id, 's-events');
  assert.deepEqual(detail.trace.prompt_refs, []);
  assert.deepEqual(detail.trace.score_summary, []);
});

test('detail for an unknown trace_id is null', () => {
  assert.equal(getSessionTraceDetail('sts:does-not-exist'), null);
});

test('observations are re-grained: one trace per session, every event an observation', () => {
  const traceId = sessionTraceId('s-events');
  const result = listSessionObservations(traceId, {});
  assert.ok(result);
  assert.equal(result.total, 3, 'every event surfaces as an observation');
  assert.equal(result.data.length, 3);
  const distinctTraceIds = new Set(result.data.map(o => o.trace_id));
  assert.equal(distinctTraceIds.size, 1, 'all observations hang under a single session trace (the regrain)');
  assert.equal([...distinctTraceIds][0], traceId, 'observations reference the session trace id');
  assert.equal(result.tree.length, 3, 'flat event observations are roots under the one session trace');
});

test('observations for an unknown trace_id are null', () => {
  assert.equal(listSessionObservations('sts:does-not-exist', {}), null);
});

test('a date-only date_to includes rows timestamped on that day (exclusive next-day)', () => {
  // Both seeded sessions started on 2026-05-01 at 10:00/10:30Z. A naive
  // `started_at <= '2026-05-01'` would drop them; the range helper treats the
  // date-only bound as the exclusive next day, so they must be included.
  const result = listSessionTraces({ date_to: '2026-05-01' });
  assert.equal(result.total, 2);
  const before = listSessionTraces({ date_to: '2026-04-30' });
  assert.equal(before.total, 0, 'the prior day excludes them');
});

test('coverage describes the full filtered set, not just the returned page', () => {
  const paged = listSessionTraces({ limit: 1 });
  assert.equal(paged.data.length, 1, 'page is limited');
  assert.equal(paged.total, 2);
  // Coverage must reflect both sessions (5 usage-bearing observations total),
  // not only the single row on this page.
  assert.equal(paged.coverage.matching_traces, 2);
  assert.equal(paged.coverage.included_traces, 2);
  assert.equal(paged.coverage.observations_with_usage, 5);
});
