import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agent-filter-spellings-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const queries = await import('../src/db/v2-queries.js');
const { listSessionTraces } = await import('../src/trace-quality/on-demand.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

const full = JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' });
db.prepare(`INSERT INTO browsing_sessions
  (id, agent, integration_mode, project, started_at, message_count, user_message_count, capabilities_json)
  VALUES ('claude-1', 'claude', 'claude-jsonl', 'demo', '2026-03-04T14:00:00Z', 5, 2, ?)`).run(full);
db.prepare(`INSERT INTO events
  (session_id, agent_type, event_type, project, model, tokens_in, tokens_out, cost_usd, client_timestamp, source)
  VALUES ('claude-1', 'claude_code', 'llm_response', 'demo', 'claude-sonnet-4-5', 100, 50, 0.01, '2026-03-04T14:00:05Z', 'import')`).run();
const message = db.prepare(`INSERT INTO messages (session_id, ordinal, role, content, content_length, timestamp)
  VALUES ('claude-1', 0, 'assistant', '[]', 2, '2026-03-04T14:00:06Z')`).run().lastInsertRowid;
db.prepare(`INSERT INTO tool_calls (message_id, session_id, tool_name, category, input_json)
  VALUES (?, 'claude-1', 'Skill', 'Other', '{"skill":"write-plan"}')`).run(message);
const summary = db.prepare(`INSERT INTO session_trace_summary
  (session_id, trace_id, agent_type, started_at, observation_count, projection_version)
  VALUES (?, ?, ?, '2026-03-04T14:00:00Z', 1, 'test')`);
// Trace summaries carry whichever spelling their source projected.
summary.run('claude-1', 'sts:claude-1', 'claude');
summary.run('claude-2', 'sts:claude-2', 'claude_code');

const window = { date_from: '2026-03-01', date_to: '2026-03-31' };

for (const agent of ['claude', 'claude_code']) {
  test(`agent=${agent} narrows Analytics to the Claude session`, () => {
    assert.equal(queries.getAnalyticsSummary({ ...window, agent }).total_sessions, 1);
  });

  test(`agent=${agent} narrows Usage to Claude's events`, () => {
    assert.equal(queries.getUsageSummary({ ...window, agent }).total_usage_events, 1);
  });

  test(`agent=${agent} narrows Skills to Claude's invocations`, () => {
    const days = queries.getAnalyticsSkillsDaily({ ...window, agent });
    assert.deepEqual(days.map(day => day.total), [1]);
  });

  test(`agent=${agent} lists Claude traces stored under either spelling`, () => {
    const ids = listSessionTraces({ ...window, agent }).data.map(trace => trace.session_id).sort();
    assert.deepEqual(ids, ['claude-1', 'claude-2']);
  });
}
