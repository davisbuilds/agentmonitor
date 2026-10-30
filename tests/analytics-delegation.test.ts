import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-delegation-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_TIMEZONE = 'UTC';
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const queries = await import('../src/db/v2-queries.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

const session = db.prepare(`INSERT INTO browsing_sessions
  (id, agent, integration_mode, project, started_at, message_count, user_message_count, parent_session_id, relationship_type)
  VALUES (?, ?, ?, 'demo', ?, ?, 1, ?, ?)`);
const usage = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, project, model, tokens_in, cost_usd, client_timestamp, source, metadata)
  VALUES (?, ?, 'llm_response', 'demo', ?, 10, ?, ?, ?, ?)`);
const uuid = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// 03/02: a Claude session and the subagent it spawned. Claude records the
// subagent's usage under the parent, marked with the subagent's agent_id.
session.run('c1', 'claude', 'claude-jsonl', '2026-03-02T10:00:00Z', 10, null, null);
session.run('c1-agent', 'claude', 'claude-jsonl', '2026-03-02T10:05:00Z', 4, 'c1', 'subagent');
usage.run('c1', 'claude_code', 'claude-opus-5-5', 1, '2026-03-02T10:01:00Z', 'import', '{}');
usage.run('c1', 'claude_code', 'claude-opus-5-5', 0.25, '2026-03-02T10:06:00Z', 'import', '{"agent_id":"a1","agent_transcript":"agent-a1"}');

// 03/03: a Codex session, its subagent, and one of Codex's own threads. Their
// usage is keyed by the native UUID; the first two list under their rollouts.
session.run(`rollout-2026-03-03T09-00-00-${uuid(1)}`, 'codex', 'codex-jsonl', '2026-03-03T09:00:00Z', 20, null, null);
session.run(`rollout-2026-03-03T09-10-00-${uuid(2)}`, 'codex', 'codex-jsonl', '2026-03-03T09:10:00Z', 6, uuid(1), 'subagent');
session.run(uuid(3), 'codex', 'codex-otel', '2026-03-03T11:00:00Z', 0, null, 'internal');
usage.run(uuid(1), 'codex', 'gpt-6-astra', 2, '2026-03-03T09:01:00Z', 'otel', '{}');
usage.run(uuid(2), 'codex', 'gpt-6-astra', 0.5, '2026-03-03T09:11:00Z', 'otel', '{}');
usage.run(uuid(3), 'codex', 'codex-auto-review', 0.1, '2026-03-03T11:01:00Z', 'otel', '{}');
// A benchmark run is not activity; Usage leaves it out, and so does this.
usage.run('bench', 'codex', 'gpt-6-astra', 9, '2026-03-03T12:00:00Z', 'benchmark', '{}');

const range = { date_from: '2026-03-02', date_to: '2026-03-04' };
const split = (started: number, subagent: number, internal: number) => ({ started, subagent, internal });

test('each day splits sessions, messages and cost by who did the work', () => {
  const { days, totals } = queries.getAnalyticsDelegation(range);
  assert.deepEqual(days.map(day => day.date), ['2026-03-02', '2026-03-03', '2026-03-04']);
  assert.deepEqual(days[0], {
    date: '2026-03-02', sessions: split(1, 1, 0), messages: split(10, 4, 0), cost_usd: split(1, 0.25, 0),
  });
  assert.deepEqual(days[1], {
    date: '2026-03-03', sessions: split(1, 1, 1), messages: split(20, 6, 0), cost_usd: split(2, 0.5, 0.1),
  });
  assert.deepEqual(days[2].cost_usd, split(0, 0, 0), 'an idle day is listed as zero');
  assert.deepEqual(totals, { sessions: split(2, 2, 1), messages: split(30, 10, 0), cost_usd: split(3, 0.75, 0.1) });
});

test('the split adds up to what Activity and Usage report', () => {
  const { days } = queries.getAnalyticsDelegation(range);
  const sum = (s: { started: number; subagent: number; internal: number }) => s.started + s.subagent + s.internal;
  const usageDaily = queries.getUsageDaily(range);
  const activity = queries.getAnalyticsActivity(range);
  assert.equal(days.length, activity.length);
  assert.ok(days.length > 0);
  days.forEach((day, index) => {
    assert.equal(Number(sum(day.cost_usd).toFixed(6)), usageDaily[index].cost_usd);
    assert.equal(sum(day.messages), activity[index].messages);
    assert.equal(day.sessions.started, activity[index].sessions);
  });
});

test('the page filters narrow every measure', () => {
  const { totals } = queries.getAnalyticsDelegation({ ...range, agent: 'claude' });
  assert.deepEqual(totals, { sessions: split(1, 1, 0), messages: split(10, 4, 0), cost_usd: split(1, 0.25, 0) });
});

test('a model filter keeps out the Claude subagent usage it excludes', () => {
  // Usage applies model, provider and tier filters after the read; the subagent pass must too.
  const { days, totals } = queries.getAnalyticsDelegation({ ...range, model: 'gpt-6-astra' });
  assert.deepEqual(days[0].cost_usd, split(0, 0, 0));
  assert.deepEqual(totals.cost_usd, split(2, 0.5, 0));
});
