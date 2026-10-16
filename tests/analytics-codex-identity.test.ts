import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-analytics-codex-identity-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const queries = await import('../src/db/v2-queries.js');
const { listWarehouseSessionTraceSummaries, listWarehouseSupersededSessionIds } = await import('../src/warehouse/source.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const uuid = '019c26b7-327b-75f3-b000-00000000000a';
const rollout = `rollout-2026-03-04T10-00-00-${uuid}`;
const solo = '019c26b7-327b-75f3-b000-00000000000b';
const full = JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' });
const summaryOnly = JSON.stringify({ history: 'none', search: 'none', tool_analytics: 'summary', live_items: 'summary' });

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
const insert = db.prepare(`INSERT INTO browsing_sessions
  (id, agent, integration_mode, project, started_at, message_count, user_message_count, capabilities_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
// One Codex session, stored by the watcher (rollout basename, its transcript)
// and by the importer (native UUID, the same conversation counted again).
insert.run(rollout, 'codex', 'codex-jsonl', 'demo', '2026-03-04T10:00:00Z', 20, 4, full);
insert.run(uuid, 'codex', 'codex-import', 'demo', '2026-03-04T10:00:01Z', 18, 3, summaryOnly);
// A Codex session known only from telemetry, and a Claude session.
insert.run(solo, 'codex', 'codex-otel', 'demo', '2026-03-04T12:00:00Z', 3, 1, summaryOnly);
insert.run('claude-1', 'claude', 'claude-jsonl', 'demo', '2026-03-04T14:00:00Z', 5, 2, full);
const message = db.prepare(`INSERT INTO messages (session_id, ordinal, role, content, content_length) VALUES (?, 0, 'assistant', '[]', 2)`)
  .run(rollout).lastInsertRowid;
const tool = db.prepare(`INSERT INTO tool_calls (message_id, session_id, tool_name, category) VALUES (?, ?, 'Bash', 'Execute')`);
tool.run(message, rollout);
tool.run(message, rollout);

test('Analytics counts a Codex session stored under its rollout and its UUID once, from its transcript row', () => {
  const summary = queries.getAnalyticsSummary();
  assert.equal(summary.total_sessions, 3);
  assert.equal(summary.total_messages, 28, 'the rollout row (20) + the solo session (3) + Claude (5)');
  assert.equal(summary.total_user_messages, 7);
  assert.equal(summary.coverage.matching_sessions, 3);

  const velocity = queries.getAnalyticsVelocity();
  assert.equal(velocity.total_sessions, 3);
  assert.equal(velocity.total_messages, 28);

  const codex = queries.getAnalyticsAgents().find(row => row.agent === 'codex');
  assert.equal(codex?.session_count, 2);
  assert.equal(codex?.message_count, 23);

  assert.deepEqual(queries.getAnalyticsProjects().map(row => [row.project, row.session_count, row.message_count]), [['demo', 3, 28]]);

  const [day] = queries.getAnalyticsActivity();
  assert.equal(day.sessions, 3);
  assert.equal(day.messages, 28);

  const cells = queries.getAnalyticsHourOfWeek();
  assert.equal(cells.reduce((sum, cell) => sum + cell.session_count, 0), 3);
  assert.equal(cells.reduce((sum, cell) => sum + cell.message_count, 0), 28);

  const top = queries.getAnalyticsTopSessions({ limit: 10 });
  assert.deepEqual(top.map(row => row.id), [rollout, 'claude-1', solo]);
  assert.equal(top[0].tool_call_count, 2);
});

test('the warehouse export publishes a Codex session once, as its event-backed summary', () => {
  const summary = db.prepare(`INSERT INTO session_trace_summary
    (session_id, trace_id, agent_type, started_at, observation_count, cost_usd, projection_version)
    VALUES (?, ?, 'codex', '2026-03-04T10:00:00Z', ?, ?, 'test')`);
  summary.run(rollout, 'sts:rollout', 40, 0);
  summary.run(uuid, 'sts:uuid', 12, 0.5);
  summary.run(solo, 'sts:solo', 3, 0.1);
  // A resumed session stored as two rollout files and no UUID summary.
  const resumed = '019c26b7-327b-75f3-b000-00000000000c';
  summary.run(`rollout-2026-03-05T09-00-00-${resumed}`, 'sts:resumed-1', 12, 0);
  summary.run(`rollout-2026-03-06T09-00-00-${resumed}`, 'sts:resumed-2', 30, 0);
  assert.deepEqual(listWarehouseSessionTraceSummaries().map(row => row.session_id).sort(),
    [uuid, solo, `rollout-2026-03-06T09-00-00-${resumed}`].sort());
  // What publishing retracts: every summary the published ones supersede, in any window.
  assert.deepEqual(listWarehouseSupersededSessionIds(), [rollout, `rollout-2026-03-05T09-00-00-${resumed}`].sort());
});
