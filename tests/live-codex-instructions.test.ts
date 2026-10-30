import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { ParsedSession } from '../src/parser/claude-code.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-live-codex-instructions-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema, runDataMigrations } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { config } = await import('../src/config.js');
const { syncCodexLiveSession } = await import('../src/live/codex-adapter.js');
const { insertParsedSession } = await import('../src/parser/claude-code.js');

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function codexSession(sessionId: string, messages: Array<[role: string, text: string]>): ParsedSession {
  return {
    messages: messages.map(([role, text], ordinal) => {
      const content = JSON.stringify([{ type: 'text', text }]);
      return {
        session_id: sessionId, ordinal, role, content, timestamp: `2026-10-15T10:00:0${ordinal}.000Z`,
        has_thinking: 0, has_tool_use: 0, content_length: content.length,
      };
    }),
    toolCalls: [],
    metadata: {
      session_id: sessionId, project: 'agentmonitor', agent: 'codex', first_message: 'Fix the build',
      started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T10:00:02.000Z',
      message_count: messages.length, user_message_count: 1, parent_session_id: null, relationship_type: null,
    },
  };
}

function items(sessionId: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  return (getDb().prepare('SELECT kind, payload_json FROM session_items WHERE session_id = ? ORDER BY id').all(sessionId) as Array<{
    kind: string; payload_json: string;
  }>).map(row => ({ kind: row.kind, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

test('Codex developer messages project as instructions, not assistant replies', () => {
  const sessionId = 'codex-instructions-sync';
  syncCodexLiveSession(getDb(), codexSession(sessionId, [
    ['developer', '<permissions instructions>sandboxed</permissions instructions>'],
    ['user', 'Fix the build'],
    ['assistant', 'Lint fails first.'],
  ]));
  assert.deepEqual(items(sessionId).map(item => item.kind), ['instructions', 'user_message', 'assistant_message']);
  assert.deepEqual(items(sessionId)[0].payload, { text: '<permissions instructions>sandboxed</permissions instructions>' });
  const turns = (getDb().prepare('SELECT COUNT(*) AS c FROM session_turns WHERE session_id = ?').get(sessionId) as { c: number }).c;
  assert.equal(turns, 3, 'every message keeps its turn, so the resumable sync only appends');
});

test('prompt capture governs instructions, as it does prompts', () => {
  const sessionId = 'codex-instructions-private';
  syncCodexLiveSession(getDb(), codexSession(sessionId, [['developer', 'Memory: private notes']]), {
    privacyPolicy: { capturePrompts: false, captureReasoning: true, captureToolArguments: true, diffPayloadMaxBytes: 32768 },
  });
  assert.deepEqual(items(sessionId)[0], {
    kind: 'instructions',
    payload: { redacted: true, reason: 'prompt_capture_disabled' },
  });
});

function seedLegacyProjection(sessionId: string, agent: 'codex' | 'claude'): void {
  const db = getDb();
  const parsed = codexSession(sessionId, [
    ['developer', 'Injected instructions'],
    ['user', 'Fix the build'],
    ['assistant', 'Lint fails first.'],
  ]);
  insertParsedSession(db, parsed, `/tmp/${sessionId}.jsonl`, 1, 'hash');
  const turn = db.prepare(`
    INSERT INTO session_turns (session_id, agent_type, source_turn_id, status, title)
    VALUES (?, ?, ?, 'completed', 't')
  `);
  const item = db.prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json)
    VALUES (?, ?, 0, ?, ?, 'success', ?)
  `);
  // How the previous release projected them: every non-user role as the assistant.
  parsed.messages.forEach((message, ordinal) => {
    const source = `${agent}-message:${ordinal}`;
    const turnId = Number(turn.run(sessionId, agent, source).lastInsertRowid);
    const text = (JSON.parse(message.content) as Array<{ text: string }>)[0].text;
    item.run(sessionId, turnId, `${source}:item:0`, message.role === 'user' ? 'user_message' : 'assistant_message', JSON.stringify({ text }));
  });
}

test('v20 relabels stored Codex developer items as instructions and leaves the rest', () => {
  const db = getDb();
  seedLegacyProjection('codex-instructions-v20', 'codex');
  // A Claude turn with the same ordinals has no developer role to match.
  seedLegacyProjection('claude-not-codex-v20', 'claude');
  db.prepare("UPDATE messages SET role = 'assistant' WHERE session_id = 'claude-not-codex-v20' AND role = 'developer'").run();

  db.pragma('user_version = 19');
  runDataMigrations(db);

  assert.deepEqual(items('codex-instructions-v20').map(item => item.kind), ['instructions', 'user_message', 'assistant_message']);
  assert.deepEqual(items('codex-instructions-v20')[0].payload, { text: 'Injected instructions' });
  assert.deepEqual(items('claude-not-codex-v20').map(item => item.kind), ['assistant_message', 'user_message', 'assistant_message']);
  assert.equal(db.pragma('user_version', { simple: true }), 26);
});

test('v20 applies the current prompt capture policy to what it relabels', () => {
  const db = getDb();
  seedLegacyProjection('codex-instructions-v20-private', 'codex');
  const previous = config.live.capture.prompts;
  config.live.capture.prompts = false;
  try {
    db.pragma('user_version = 19');
    runDataMigrations(db);
  } finally {
    config.live.capture.prompts = previous;
  }
  assert.deepEqual(items('codex-instructions-v20-private')[0], {
    kind: 'instructions',
    payload: { redacted: true, reason: 'prompt_capture_disabled' },
  });
  // An assistant reply is not a prompt.
  assert.deepEqual(items('codex-instructions-v20-private')[2].payload, { text: 'Lint fails first.' });
});
