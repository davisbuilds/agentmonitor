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
