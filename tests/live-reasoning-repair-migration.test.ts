import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-live-reasoning-migration-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema, runDataMigrations } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { config } = await import('../src/config.js');
const { ensureSessionTraceSummaryBackfill, maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const SESSION = 'live-reasoning-v18';

function seed(): Record<string, number> {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (id, project, agent, first_message, message_count, user_message_count, integration_mode, fidelity)
    VALUES (?, 'demo', 'claude', 'Fix the build', 5, 1, 'claude-jsonl', 'full')
  `).run(SESSION);
  const message = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, '2026-10-01T10:00:00.000Z', ?, 0, 10)
  `);
  message.run(SESSION, 0, 'user', JSON.stringify([{ type: 'text', text: 'Fix the build' }]), 0);
  message.run(SESSION, 1, 'assistant', JSON.stringify([{ type: 'thinking', text: 'Lint fails first' }]), 1);
  message.run(SESSION, 2, 'assistant', JSON.stringify([{ type: 'thinking', text: '' }]), 1);
  message.run(SESSION, 3, 'assistant', JSON.stringify([{ type: 'thinking', text: 'Kept' }]), 1);
  message.run(SESSION, 4, 'assistant', JSON.stringify([{ type: 'thinking', text: 'First' }, { type: 'thinking', text: 'Second' }]), 1);

  const turn = db.prepare(`
    INSERT INTO session_turns (session_id, agent_type, source_turn_id, status, title)
    VALUES (?, 'claude', ?, 'completed', 't')
  `);
  const item = db.prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json)
    VALUES (?, ?, 0, ?, ?, 'success', ?)
  `);
  const ids: Record<string, number> = {};
  const add = (name: string, ordinal: number, kind: string, payload: object): void => {
    const turnId = Number(turn.run(SESSION, `claude-message:${ordinal}`).lastInsertRowid);
    ids[name] = Number(item.run(SESSION, turnId, `claude-message:${ordinal}:item:0`, kind, JSON.stringify(payload)).lastInsertRowid);
  };
  add('user', 0, 'user_message', { text: 'Fix the build' });
  add('withText', 1, 'reasoning', { text: '' });
  add('empty', 2, 'reasoning', { text: '' });
  add('redacted', 3, 'reasoning', { redacted: true, reason: 'reasoning_capture_disabled' });
  // One item for two thinking blocks: which text it held is unknown.
  add('ambiguous', 4, 'reasoning', { text: '' });
  return ids;
}

test('v18 restores live reasoning text from the transcript and removes empty reasoning', () => {
  const db = getDb();
  const ids = seed();
  // The summary as the previous release derived it, counting every stored item.
  maintainSessionTraceSummary(SESSION);
  db.prepare("UPDATE session_trace_summary SET projection_version = 'sts:v3'").run();

  db.pragma('user_version = 17');
  runDataMigrations(db);

  const rows = new Map((db.prepare('SELECT id, kind, payload_json FROM session_items WHERE session_id = ?').all(SESSION) as Array<{
    id: number; kind: string; payload_json: string;
  }>).map(row => [row.id, JSON.parse(row.payload_json) as Record<string, unknown>]));
  assert.deepEqual(rows.get(ids.withText), { text: 'Lint fails first' }, 'the transcript recorded this text');
  assert.equal(rows.has(ids.empty), false, 'a thinking block without text has nothing to show');
  assert.equal(rows.has(ids.ambiguous), false, 'an item that cannot be paired with one block is removed, not guessed');
  assert.deepEqual(rows.get(ids.redacted), { redacted: true, reason: 'reasoning_capture_disabled' }, 'a redacted item is untouched');
  assert.deepEqual(rows.get(ids.user), { text: 'Fix the build' }, 'other kinds are untouched');
  const turns = (db.prepare('SELECT COUNT(*) AS c FROM session_turns WHERE session_id = ?').get(SESSION) as { c: number }).c;
  assert.equal(turns, 5, 'every message keeps its turn, so the next sync only appends');
  assert.equal(db.pragma('user_version', { simple: true }), 18);
});

test('the trace summary is re-derived without the removed reasoning', () => {
  const db = getDb();
  const summaryRow = () => db.prepare('SELECT observation_count, coverage_json FROM session_trace_summary WHERE session_id = ?').get(SESSION) as
    { observation_count: number; coverage_json: string };
  const before = summaryRow().observation_count;
  ensureSessionTraceSummaryBackfill();
  const after = summaryRow();
  assert.equal(after.observation_count, before - 2, 'the removed reasoning items are no longer counted');
  assert.equal((JSON.parse(after.coverage_json) as { has_reasoning?: boolean }).has_reasoning, true, 'the restored text counts as reasoning');
});

test('v18 restores reasoning under the current capture policy', () => {
  const db = getDb();
  const sessionId = 'live-reasoning-v18-private';
  db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, 0, 'assistant', ?, '2026-10-01T11:00:00.000Z', 1, 0, 10)
  `).run(sessionId, JSON.stringify([{ type: 'thinking', text: 'Private reasoning' }]));
  const turnId = Number(db.prepare(`
    INSERT INTO session_turns (session_id, agent_type, source_turn_id, status, title)
    VALUES (?, 'claude', 'claude-message:0', 'completed', 't')
  `).run(sessionId).lastInsertRowid);
  const itemId = Number(db.prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json)
    VALUES (?, ?, 0, 'claude-message:0:item:0', 'reasoning', 'success', '{"text":""}')
  `).run(sessionId, turnId).lastInsertRowid);

  const previous = config.live.capture.reasoning;
  config.live.capture.reasoning = false;
  try {
    db.pragma('user_version = 17');
    runDataMigrations(db);
  } finally {
    config.live.capture.reasoning = previous;
  }

  const row = db.prepare('SELECT payload_json FROM session_items WHERE id = ?').get(itemId) as { payload_json: string };
  assert.deepEqual(JSON.parse(row.payload_json), { redacted: true, reason: 'reasoning_capture_disabled' });
});
