import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-friction-'));
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
  (id, agent, integration_mode, project, title, started_at, message_count, user_message_count, parent_session_id, relationship_type)
  VALUES (?, ?, ?, ?, ?, ?, 10, 1, ?, ?)`);
const message = db.prepare('INSERT INTO messages (session_id, ordinal, role, content) VALUES (?, ?, ?, ?)');
const toolCall = db.prepare('INSERT INTO tool_calls (message_id, session_id, tool_name, tool_use_id, input_json) VALUES (?, ?, ?, ?, \'{}\')');
const turn = db.prepare("INSERT INTO session_turns (session_id, agent_type, source_turn_id, created_at) VALUES (?, ?, ?, '2026-03-02T10:00:00Z')");
const item = db.prepare(`INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at)
  VALUES (?, ?, 0, ?, 'tool_result', ?, '{}', ?)`);

const text = (value: string) => JSON.stringify([{ type: 'text', text: value }]);
const at = (second: number) => new Date(Date.UTC(2026, 2, 2, 10, 0, second)).toISOString();
/** Messages 0..count-1 for a session; returns their row ids by ordinal. */
function messages(sessionId: string, count: number, overrides: Record<number, [string, string]> = {}): number[] {
  return Array.from({ length: count }, (_, ordinal) => {
    const [role, content] = overrides[ordinal] ?? [ordinal % 2 === 0 ? 'user' : 'assistant', text(`message ${ordinal}`)];
    return Number(message.run(sessionId, ordinal, role, content).lastInsertRowid);
  });
}
/** Claude tool outcomes, each on the turn of the message that returned it, in order. */
function claudeResults(sessionId: string, outcomes: Array<[number, 'success' | 'error']>) {
  outcomes.forEach(([ordinal, status], index) => {
    const turnId = Number(turn.run(sessionId, 'claude_code', `claude-message:${ordinal}`).lastInsertRowid);
    item.run(sessionId, turnId, `toolu_${sessionId}_${ordinal}`, status, at(index));
  });
}

// Claude, alpha: three failures in a row from message 5, and one interruption.
session.run('c1', 'claude', 'claude-jsonl', 'alpha', 'Refactor', '2026-03-02T10:00:00Z', null, null);
messages('c1', 12, { 10: ['user', text('[Request interrupted by user]')] });
claudeResults('c1', [[3, 'success'], [4, 'error'], [4, 'success'], [5, 'error'], [6, 'error'], [7, 'error'], [9, 'success']]);

// Claude, alpha: as many failures, never three in a row, so nothing to flag.
session.run('c2', 'claude', 'claude-jsonl', 'alpha', 'Long sweep', '2026-03-02T12:00:00Z', null, null);
messages('c2', 10);
claudeResults('c2', [[1, 'error'], [2, 'error'], [3, 'success'], [4, 'error'], [5, 'error'], [6, 'success'], [7, 'error']]);

// Codex, beta: the rollout row lists the session; OTEL records outcomes on the
// native UUID row by call id, and the rollout's own results record none.
const uuid = '01990000-0000-7000-8000-000000000001';
const rollout = `rollout-2026-03-03T09-00-00-${uuid}`;
session.run(rollout, 'codex', 'codex-jsonl', 'beta', 'Port the parser', '2026-03-03T09:00:00Z', null, null);
session.run(uuid, 'codex', 'codex-otel', 'beta', null, '2026-03-03T09:00:00Z', null, null);
const cx = messages(rollout, 8);
['call_S', 'call_A', 'call_B', 'call_C', 'call_D'].forEach((call, index) => toolCall.run(cx[index + 2], rollout, 'exec', call));
(['success', 'error', 'error', 'error', 'success'] as const).forEach((status, index) =>
  item.run(uuid, null, `call_${'SABCD'[index]}:result`, status, at(index)));
item.run(rollout, null, 'call_A:rollout', 'completed', at(1));

// Codex, beta: failures inside a code-mode exec carry call ids no stored tool
// call has, so the streak opens at the last message before its first failure.
const uuid2 = '01990000-0000-7000-8000-000000000002';
const rollout2 = `rollout-2026-03-04T09-00-00-${uuid2}`;
session.run(rollout2, 'codex', 'codex-jsonl', 'beta', 'Nested calls', '2026-03-04T09:00:00Z', null, null);
session.run(uuid2, 'codex', 'codex-otel', 'beta', null, '2026-03-04T09:00:00Z', null, null);
const timed = db.prepare('INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, ?, ?, ?)');
for (const ordinal of [0, 1, 2, 3]) timed.run(rollout2, ordinal, 'assistant', text(`step ${ordinal}`), at(ordinal * 10));
['inner_1', 'inner_2', 'inner_3'].forEach((call, index) => item.run(uuid2, null, `${call}:result`, 'error', at(15 + index)));

// Delegated work meets friction on its own clock and is left out.
session.run('c-sub', 'claude', 'claude-jsonl', 'alpha', null, '2026-03-02T10:30:00Z', 'c1', 'subagent');
claudeResults('c-sub', [[1, 'error'], [2, 'error'], [3, 'error']]);

const range = { date_from: '2026-03-01', date_to: '2026-03-31' };
const c1Signals = [
  { kind: 'failure_streak', count: 3, ordinal: 5 },
  { kind: 'interruptions', count: 1, ordinal: 10 },
];
const codexSignals = [{ kind: 'failure_streak', count: 3, ordinal: 3 }];

test('each session shows its signals, each opening where it starts', () => {
  assert.deepEqual(queries.getSessionFriction('c1'), c1Signals);
  assert.deepEqual(queries.getSessionFriction(rollout), codexSignals, 'the UUID row\'s outcomes reach the listed rollout');
  assert.deepEqual(queries.getSessionFriction('c2'), [], 'scattered failures are not a streak');
  assert.deepEqual(queries.getSessionFriction(rollout2), [{ kind: 'failure_streak', count: 3, ordinal: 1 }]);
});

test('the range counts sessions per signal and lists the latest that met friction', () => {
  const friction = queries.getAnalyticsFriction(range);
  assert.deepEqual([friction.sessions, friction.with_friction, friction.failure_streaks, friction.interruptions], [4, 3, 3, 1]);
  assert.deepEqual(friction.recent.map(row => [row.id, row.title, row.signals]), [
    [rollout2, 'Nested calls', [{ kind: 'failure_streak', count: 3, ordinal: 1 }]],
    [rollout, 'Port the parser', codexSignals],
    ['c1', 'Refactor', c1Signals],
  ]);
});

test('the page filters narrow the sessions read', () => {
  const friction = queries.getAnalyticsFriction({ ...range, agent: 'claude' });
  assert.deepEqual([friction.sessions, friction.recent.map(row => row.id)], [2, ['c1']]);
});
