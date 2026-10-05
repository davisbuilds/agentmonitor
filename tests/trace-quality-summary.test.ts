import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { getDb as getDbType, closeDb as closeDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';
import type {
  backfillSessionTraceSummaries as backfillType,
  bumpSessionTraceSummaryForEvent as bumpType,
  deriveSessionTraceSummary as deriveType,
  maintainSessionTraceSummary as maintainType,
} from '../src/trace-quality/summary.js';

let tempDir = '';
let getDb: typeof getDbType;
let closeDb: typeof closeDbType;
let initSchema: typeof initSchemaType;
let deriveSessionTraceSummary: typeof deriveType;
let maintainSessionTraceSummary: typeof maintainType;
let bumpSessionTraceSummaryForEvent: typeof bumpType;
let backfillSessionTraceSummaries: typeof backfillType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-tq-summary-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'tq-summary.db');

  initSchema = (await import('../src/db/schema.js')).initSchema;
  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const summary = await import('../src/trace-quality/summary.js');
  deriveSessionTraceSummary = summary.deriveSessionTraceSummary;
  maintainSessionTraceSummary = summary.maintainSessionTraceSummary;
  bumpSessionTraceSummaryForEvent = summary.bumpSessionTraceSummaryForEvent;
  backfillSessionTraceSummaries = summary.backfillSessionTraceSummaries;

  initSchema();
  seed();
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
  session.run('s-empty', 'a1', 'claude', '2026-05-01T11:00:00Z'); // no events => no summary

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

test('summary measures equal a direct SUM over the session events', () => {
  const summary = deriveSessionTraceSummary('s-events');
  const totals = getDb().prepare(`
    SELECT COUNT(*) c, SUM(tokens_in) ti, SUM(tokens_out) to_, SUM(cost_usd) cost,
           SUM(COALESCE(duration_ms,0)) lat, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errs
    FROM events WHERE session_id = 's-events'
  `).get() as { c: number; ti: number; to_: number; cost: number; lat: number; errs: number };

  assert.equal(summary.observation_count, totals.c);
  assert.equal(summary.tokens_in, totals.ti);
  assert.equal(summary.tokens_out, totals.to_);
  assert.equal(Math.round(summary.cost_usd * 1e6), Math.round(totals.cost * 1e6));
  assert.equal(summary.latency_ms_total, totals.lat);
  assert.equal(summary.error_count, totals.errs);
  assert.equal(summary.primary_model, 'claude-opus-4-8');
});

test('quality scalar is deterministic and within [0,1]', () => {
  const a = deriveSessionTraceSummary('s-events');
  const b = deriveSessionTraceSummary('s-events');
  assert.equal(a.quality_score, b.quality_score);
  assert.ok(a.quality_score !== null && a.quality_score >= 0 && a.quality_score <= 1);
  assert.match(a.quality_grade ?? '', /^[A-F]$/);
});

test('a session with no observations gets a null quality scalar', () => {
  const summary = deriveSessionTraceSummary('s-empty');
  assert.equal(summary.observation_count, 0);
  assert.equal(summary.quality_score, null);
  assert.equal(summary.quality_grade, null);
});

test('persisted summary is content-free (no message/text columns)', () => {
  maintainSessionTraceSummary('s-events');
  const cols = (getDb().prepare(`PRAGMA table_info(session_trace_summary)`).all() as Array<{ name: string }>).map(c => c.name);
  for (const banned of ['content', 'message', 'text', 'payload', 'transcript', 'input', 'output']) {
    assert.ok(!cols.some(c => c.includes(banned)), `summary must not carry a '${banned}' column`);
  }
});

test('backfill writes one row per event-bearing session, not per event', () => {
  backfillSessionTraceSummaries();
  const rows = (getDb().prepare('SELECT COUNT(*) c FROM session_trace_summary').get() as { c: number }).c;
  // 5 events across 2 sessions (s-empty has none) => exactly 2 summary rows.
  assert.equal(rows, 2);
  const sEvents = (getDb().prepare("SELECT observation_count FROM session_trace_summary WHERE session_id = 's-events'").get() as { observation_count: number });
  assert.equal(sEvents.observation_count, 3, 'one row aggregating the session\'s 3 events');
});

test('event usage is preserved when the detail projection comes from live session_items (Codex)', () => {
  // Regression for PR #37 P1: a Codex session has events with real usage AND
  // materialized session_items. projectTraceQuality structures detail from the
  // items (zero usage); the summary must still roll up the event tokens/cost.
  const db = getDb();
  db.prepare(`INSERT INTO browsing_sessions (id, agent, started_at, ended_at) VALUES ('s-codex', 'codex', ?, ?)`)
    .run('2026-05-01T12:00:00Z', '2026-05-01T12:05:00Z');
  db.prepare(`INSERT INTO session_turns (id, session_id, agent_type, started_at) VALUES (900, 's-codex', 'codex', ?)`)
    .run('2026-05-01T12:00:00Z');
  db.prepare(`INSERT INTO session_items (session_id, turn_id, ordinal, kind, payload_json, created_at)
              VALUES ('s-codex', 900, 0, 'tool_call', '{}', ?)`).run('2026-05-01T12:00:30Z');
  db.prepare(
    `INSERT INTO events (id, event_id, session_id, agent_type, event_type, tool_name, status, model,
       tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, created_at)
     VALUES (?, ?, 's-codex', 'codex', ?, ?, 'success', 'gpt-5-codex', ?, ?, 0, 0, ?, ?, ?)`,
  ).run(900, 'ce1', 'tool_use', 'apply_patch', 1000, 500, 0.5, 700, '2026-05-01T12:00:00Z');

  const summary = deriveSessionTraceSummary('s-codex');
  assert.equal(summary.tokens_in, 1000, 'event tokens must survive the item-based detail projection');
  assert.equal(summary.tokens_out, 500);
  assert.equal(summary.cost_usd, 0.5);
  assert.equal(summary.primary_model, 'gpt-5-codex');
  assert.equal(summary.coverage.has_token_usage, true);
});

test('incremental per-event bump matches the full derive for an event-sourced session', () => {
  const db = getDb();
  db.prepare('DELETE FROM session_trace_summary WHERE session_id = ?').run('s-events');
  for (const id of [1, 2, 3]) bumpSessionTraceSummaryForEvent(id);

  const incremental = db.prepare('SELECT * FROM session_trace_summary WHERE session_id = ?').get('s-events') as Record<string, unknown>;
  const full = deriveSessionTraceSummary('s-events');

  assert.equal(incremental.observation_count, full.observation_count);
  assert.equal(incremental.tokens_in, full.tokens_in);
  assert.equal(incremental.tokens_out, full.tokens_out);
  assert.equal(incremental.error_count, full.error_count);
  assert.equal(Math.round((incremental.cost_usd as number) * 1e6), Math.round(full.cost_usd * 1e6));
  assert.equal(incremental.latency_ms_total, full.latency_ms_total);
  assert.equal(incremental.quality_score, full.quality_score);
});

function preparedSql(fn: () => void): string[] {
  const db = getDb();
  const original = db.prepare.bind(db);
  const seen: string[] = [];
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return original(sql);
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = original;
  }
  return seen;
}

test('an event-sourced derive reads no message, tool-call, item or turn bodies', () => {
  // The watcher re-derives on every transcript append; those tables hold the
  // session's full text, which an event-sourced summary never uses.
  const db = getDb();
  db.prepare(`INSERT INTO browsing_sessions (id, agent, project, started_at, ended_at) VALUES ('s-heavy', 'claude', 'proj', ?, ?)`)
    .run('2026-05-02T09:00:00Z', '2026-05-02T09:30:00Z');
  db.prepare(`INSERT INTO messages (session_id, ordinal, role, content) VALUES ('s-heavy', 0, 'user', ?)`).run('x'.repeat(1000));
  db.prepare(
    `INSERT INTO events (id, event_id, session_id, agent_type, event_type, status, model,
       tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
     VALUES (950, 'h1', 's-heavy', 'claude', 'response', 'success', 'claude-opus-4-8', 10, 20, 0, 0, 0.01, ?)`,
  ).run('2026-05-02T09:01:00Z');

  const seen = preparedSql(() => maintainSessionTraceSummary('s-heavy'));
  const heavy = seen.filter(sql => /\bFROM\s+(messages|tool_calls|session_items|session_turns)\b/i.test(sql) && /SELECT\s+\*/i.test(sql));
  assert.deepEqual(heavy, [], 'event-sourced derive must not load transcript rows');
  assert.ok(!seen.some(sql => /SELECT\s+\*\s+FROM\s+events/i.test(sql)), 'reads only the event columns the rollup uses');
  assert.equal(deriveSessionTraceSummary('s-heavy').tokens_out, 20);
});

test('event-sourced metadata prefers the browsing session, then turns, then events', () => {
  const db = getDb();
  const event = db.prepare(
    `INSERT INTO events (id, event_id, session_id, agent_type, event_type, status, project,
       tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, created_at, client_timestamp)
     VALUES (?, ?, ?, ?, 'response', 'success', ?, 1, 1, 0, 0, ?, ?)`,
  );
  // Browsing session wins for agent, project and the time span.
  db.prepare(`INSERT INTO browsing_sessions (id, agent, project, started_at, ended_at) VALUES ('s-meta-bs', 'claude', 'bs-proj', ?, ?)`)
    .run('2026-05-03T08:00:00Z', '2026-05-03T09:00:00Z');
  event.run(960, 'm1', 's-meta-bs', 'codex', 'ev-proj', '2026-05-03T08:10:00Z', null);
  const fromBrowsing = deriveSessionTraceSummary('s-meta-bs');
  assert.equal(fromBrowsing.agent_type, 'claude');
  assert.equal(fromBrowsing.project, 'bs-proj');
  assert.equal(fromBrowsing.started_at, '2026-05-03T08:00:00Z');
  assert.equal(fromBrowsing.ended_at, '2026-05-03T09:00:00Z');

  // No browsing session: the earliest turn's agent, then the earliest event
  // carrying a project, and the event time span (client time first). The
  // project names sort against time so an unordered read picks the wrong one.
  db.prepare(`INSERT INTO session_turns (id, session_id, agent_type, started_at) VALUES (961, 's-meta-ev', 'antigravity', ?)`)
    .run('2026-05-03T10:00:00Z');
  db.prepare(`INSERT INTO session_turns (id, session_id, agent_type, started_at) VALUES (962, 's-meta-ev', 'gemini', ?)`)
    .run('2026-05-03T11:00:00Z');
  event.run(963, 'm2', 's-meta-ev', 'codex', 'alpha-later-proj', '2026-05-03T10:20:00Z', null);
  event.run(964, 'm3', 's-meta-ev', 'claude', null, '2026-05-03T10:30:00Z', '2026-05-03T10:00:00Z');
  event.run(965, 'm4', 's-meta-ev', 'claude', 'zeta-first-proj', '2026-05-03T10:40:00Z', '2026-05-03T10:05:00Z');
  const fromEvents = deriveSessionTraceSummary('s-meta-ev');
  assert.equal(fromEvents.agent_type, 'antigravity');
  assert.equal(fromEvents.project, 'zeta-first-proj');
  assert.equal(fromEvents.started_at, '2026-05-03T10:00:00Z');
  assert.equal(fromEvents.ended_at, '2026-05-03T10:20:00Z');

  // No browsing session and no turns: the earliest event's agent. Insertion,
  // alphabetical and created_at order all point at the other event.
  event.run(966, 'm5', 's-meta-only', 'claude', null, '2026-05-03T12:10:00Z', null);
  event.run(967, 'm6', 's-meta-only', 'codex', null, '2026-05-03T12:20:00Z', '2026-05-03T12:00:00Z');
  assert.equal(deriveSessionTraceSummary('s-meta-only').agent_type, 'codex');
});
