import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-analytics-headlines-'));
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

// One Codex session, two rows: the rollout transcript the session list shows,
// and the OTEL row its usage and tool outcomes arrived on.
const codexId = '01990000-0000-7000-8000-000000000001';
const rolloutId = `rollout-2026-03-04T09-00-00-${codexId}`;
const session = db.prepare(`INSERT INTO browsing_sessions
  (id, agent, integration_mode, project, started_at, message_count, user_message_count, parent_session_id, relationship_type)
  VALUES (?, ?, ?, 'demo', ?, ?, ?, ?, ?)`);
session.run('a', 'claude', 'claude-jsonl', '2026-03-02T10:00:00Z', 3, 2, null, null);
session.run('a-sub', 'claude', 'claude-jsonl', '2026-03-02T10:05:00Z', 2, 1, 'a', 'subagent');
session.run(rolloutId, 'codex', 'codex-jsonl', '2026-03-04T09:00:00Z', 2, 1, null, null);
session.run(codexId, 'codex', 'codex-otel', '2026-03-04T09:00:00Z', 0, 1, null, null);
session.run('p', 'claude', 'claude-jsonl', '2026-02-28T10:00:00Z', 2, 3, null, null);

const message = db.prepare(`INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, 'assistant', '[]', ?)`);
const messages: Array<[string, string[]]> = [
  // The subagent runs inside its parent's time, so it adds no active time.
  ['a', ['2026-03-02T10:00:00Z', '2026-03-02T10:10:00Z', '2026-03-02T10:40:00Z']],
  ['a-sub', ['2026-03-02T10:05:00Z', '2026-03-02T10:06:00Z']],
  [rolloutId, ['2026-03-04T09:00:00Z', '2026-03-04T09:20:00Z']],
  ['p', ['2026-02-28T10:00:00Z', '2026-02-28T10:12:00Z']],
];
for (const [id, times] of messages) times.forEach((time, ordinal) => message.run(id, ordinal, time));

const item = db.prepare(`INSERT INTO session_items (session_id, kind, status) VALUES (?, 'tool_result', ?)`);
for (const status of ['success', 'success', 'success', 'error']) item.run('a', status);
// The rollout records no outcome ('completed'); it counts neither way.
for (const status of ['success', 'error']) item.run(codexId, status);
item.run(rolloutId, 'completed');
for (const status of ['success', 'error']) item.run('p', status);

const usage = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, model, tokens_in, cost_usd, client_timestamp, source)
  VALUES (?, ?, 'llm_response', 'claude-opus-5-5', 10, ?, ?, 'import')`);
usage.run('a', 'claude_code', 1.0, '2026-03-02T10:01:00Z');
usage.run(codexId, 'codex', 0.5, '2026-03-04T09:01:00Z');
// Usage from a session whose transcript is gone counts in cost, not in cost per session.
usage.run('ghost', 'claude_code', 2.0, '2026-03-03T12:00:00Z');
usage.run('p', 'claude_code', 1.0, '2026-02-28T10:01:00Z');

const range = { date_from: '2026-03-02', date_to: '2026-03-04' };

test('the overview compares each headline with the period before, day by day', () => {
  const overview = queries.getAnalyticsHeadlines(range);
  assert.deepEqual(overview.days, ['2026-03-02', '2026-03-03', '2026-03-04']);
  assert.deepEqual(overview.prior_range, { from: '2026-02-27', to: '2026-03-01' });

  assert.deepEqual([overview.cost.value, overview.cost.prior, overview.cost.daily], [3.5, 1, [1, 2, 0.5]]);
  assert.deepEqual([overview.cost.per_session_usd, overview.cost.sessions_with_transcript, overview.cost.usage_sessions], [0.75, 2, 3]);

  assert.deepEqual([overview.prompts.value, overview.prompts.prior, overview.prompts.daily], [4, 3, [3, 0, 1]]);

  assert.deepEqual([overview.sessions.value, overview.sessions.prior, overview.sessions.daily], [2, 1, [1, 0, 1]]);
  assert.equal(overview.sessions.delegated_share, 0.33);
  assert.deepEqual(overview.sessions.daily_delegated_share, [0.5, null, 0]);

  // Each gap counts up to 15 minutes, the return after a break too: 03/02 is
  // 5 + 1 + 4 + 15 minutes, 03/04 is 15 (two days idle) + 15 (a 20-minute gap).
  assert.deepEqual(overview.active_hours, { value: 0.92, prior: 0.2, daily: [0.42, 0, 0.5] });
});

test('tool error rates stay per agent, each over the outcomes that agent records', () => {
  const byAgent = Object.fromEntries(queries.getAnalyticsHeadlines(range).tool_errors.map(row => [row.agent, row]));
  assert.deepEqual(Object.keys(byAgent).sort(), ['claude', 'codex']);
  assert.deepEqual(byAgent.claude, { agent: 'claude', results: 4, errors: 1, rate: 0.25, prior_rate: 0.5 });
  assert.deepEqual(byAgent.codex, { agent: 'codex', results: 2, errors: 1, rate: 0.5, prior_rate: null });
});

test('an agent filter narrows every headline to that agent', () => {
  const overview = queries.getAnalyticsHeadlines({ ...range, agent: 'codex' });
  assert.equal(overview.cost.value, 0.5);
  assert.equal(overview.sessions.value, 1);
  assert.deepEqual(overview.tool_errors.map(row => row.agent), ['codex']);
  assert.equal(overview.active_hours.value, 0.25);
});

test('a telemetry-only session has a row but no transcript, so cost per session leaves it out', () => {
  const summaryOnly = '01990000-0000-7000-8000-000000000002';
  session.run(summaryOnly, 'codex', 'codex-summary', '2026-03-03T08:00:00Z', 0, 0, null, null);
  usage.run(summaryOnly, 'codex', 0.25, '2026-03-03T08:01:00Z');
  const { cost } = queries.getAnalyticsHeadlines(range);
  assert.deepEqual([cost.per_session_usd, cost.sessions_with_transcript, cost.usage_sessions], [0.75, 2, 4]);
});
