import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-hour-of-week-messages-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
// Kathmandu is UTC+5:45: a cell boundary there falls inside a UTC hour.
process.env.AGENTMONITOR_TIMEZONE = 'Asia/Kathmandu';
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
  (id, agent, integration_mode, project, started_at, message_count, user_message_count)
  VALUES (?, ?, ?, 'demo', ?, ?, ?)`);
const message = db.prepare('INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, ?, ?, ?)');
const prompt = JSON.stringify([{ type: 'text', text: 'go on' }]);
const toolResult = JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
const reply = JSON.stringify([{ type: 'text', text: 'done' }]);

// Started Monday 2026-03-02 at 10:20 local (04:35Z), resumed at 20:00 local (14:15Z).
session.run('resumed', 'claude', 'claude-jsonl', '2026-03-02T04:35:00Z', 4, 2);
message.run('resumed', 0, 'user', prompt, '2026-03-02T04:35:00Z'); //    10:20 local
message.run('resumed', 1, 'assistant', reply, '2026-03-02T04:40:00Z'); // 10:25
message.run('resumed', 2, 'user', toolResult, '2026-03-02T05:14:00Z'); // 10:59
message.run('resumed', 3, 'user', prompt, '2026-03-02T14:15:00Z'); //    20:00
// A session with no stored messages (summary-only) stays at its start hour.
session.run('summary', 'codex', 'codex-otel', '2026-03-03T03:30:00Z', 5, 1); // Tue 09:15

test('the heatmap places each message at its own local hour', () => {
  const cells = queries.getAnalyticsHourOfWeek({ date_from: '2026-03-01', date_to: '2026-03-31' })
    .filter(cell => cell.message_count > 0)
    .map(cell => [cell.day_of_week, cell.hour_of_day, cell.session_count, cell.message_count, cell.user_message_count]);
  assert.deepEqual(cells, [
    [0, 10, 1, 3, 1],
    [0, 20, 1, 1, 1],
    [1, 9, 1, 5, 1],
  ]);
});

test('a session whose messages all fall outside the window adds nothing at its start hour', () => {
  // Started Monday evening, every message sent two days later.
  session.run('carried', 'claude', 'claude-jsonl', '2026-03-02T15:00:00Z', 2, 1); // Mon 20:45
  message.run('carried', 0, 'user', prompt, '2026-03-04T06:00:00Z');
  message.run('carried', 1, 'assistant', reply, '2026-03-04T06:01:00Z');
  const cells = queries.getAnalyticsHourOfWeek({ date_from: '2026-03-02', date_to: '2026-03-02' })
    .filter(cell => cell.message_count > 0)
    .map(cell => [cell.day_of_week, cell.hour_of_day, cell.session_count, cell.message_count, cell.user_message_count]);
  assert.deepEqual(cells, [
    [0, 10, 1, 3, 1],
    [0, 20, 1, 1, 1],
  ]);
});
