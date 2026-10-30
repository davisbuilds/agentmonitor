import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-activity-days-'));
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
const session = db.prepare(`INSERT INTO browsing_sessions (id, agent, project, started_at, message_count, user_message_count)
  VALUES (?, 'claude', 'demo', ?, ?, 1)`);
session.run('a', '2026-03-02T10:00:00Z', 4);
session.run('b', '2026-03-05T10:00:00Z', 6);

test('activity lists every day of the selected range, idle days as zero', () => {
  const days = queries.getAnalyticsActivity({ date_from: '2026-03-01', date_to: '2026-03-06' })
    .map(day => [day.date, day.sessions, day.messages]);
  assert.deepEqual(days, [
    ['2026-03-01', 0, 0],
    ['2026-03-02', 1, 4],
    ['2026-03-03', 0, 0],
    ['2026-03-04', 0, 0],
    ['2026-03-05', 1, 6],
    ['2026-03-06', 0, 0],
  ]);
});

test('without a range, activity spans the first to the last active day', () => {
  assert.deepEqual(queries.getAnalyticsActivity().map(day => day.date), [
    '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05',
  ]);
});

const event = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, tokens_in, cost_usd, client_timestamp, source)
  VALUES (?, 'claude_code', 'llm_response', 10, 0.01, ?, 'import')`);
event.run('a', '2026-03-02T10:00:05Z');
event.run('b', '2026-03-05T10:00:05Z');

test('per-day averages divide by the days of the selected range', () => {
  const range = { date_from: '2026-03-01', date_to: '2026-03-06' };
  const summary = queries.getAnalyticsSummary(range);
  assert.equal(summary.daily_average_sessions, 0.33, '2 sessions over 6 days, not over the 4 from first to last');
  assert.equal(summary.daily_average_messages, 1.67);

  const velocity = queries.getAnalyticsVelocity(range);
  assert.equal(velocity.span_days, 6);
  assert.equal(velocity.sessions_per_calendar_day, 0.33);
  assert.equal(velocity.active_days, 2);

  assert.equal(queries.getUsageSummary(range).span_days, 6);
});

test('without a range, the averages span the first to the last active day', () => {
  assert.equal(queries.getAnalyticsSummary().daily_average_sessions, 0.5);
  assert.equal(queries.getAnalyticsVelocity().span_days, 4);
});
