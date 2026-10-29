import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-analytics-subagents-'));
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
  (id, agent, project, started_at, message_count, user_message_count, parent_session_id, relationship_type)
  VALUES (?, ?, 'demo', '2026-03-02T10:00:00Z', ?, ?, ?, ?)`);
session.run('parent', 'claude', 10, 2, null, null);
// Work the parent delegated, and a Codex app job no one started by hand.
session.run('agent-child', 'claude', 6, 1, 'parent', 'subagent');
session.run('codex-job', 'codex', 2, 1, null, 'internal');

const range = { date_from: '2026-03-01', date_to: '2026-03-31' };

test('Analytics counts the sessions someone started, with their subagents\' messages', () => {
  const summary = queries.getAnalyticsSummary(range);
  assert.equal(summary.total_sessions, 1);
  assert.equal(summary.total_messages, 18);

  assert.equal(queries.getAnalyticsVelocity(range).total_sessions, 1);
  assert.equal(queries.getAnalyticsVelocity(range).average_messages_per_session, 18);

  const day = queries.getAnalyticsActivity(range).find(point => point.date === '2026-03-02');
  assert.deepEqual([day?.sessions, day?.messages], [1, 18]);

  assert.deepEqual(queries.getAnalyticsProjects(range).map(row => [row.project, row.session_count, row.message_count]),
    [['demo', 1, 18]]);

  const agents = Object.fromEntries(queries.getAnalyticsAgents(range).map(row => [row.agent, [row.session_count, row.message_count]]));
  assert.deepEqual(agents, { claude: [1, 16], codex: [0, 2] });
});
