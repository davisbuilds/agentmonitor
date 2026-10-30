import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-claude-user-count-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');
const { parseSessionMessages } = await import('../src/parser/claude-code.js');
const { initSchema, runDataMigrations } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function line(role: 'user' | 'assistant', content: unknown, second: number): string {
  return JSON.stringify({
    type: role,
    sessionId: 's1',
    timestamp: `2026-07-07T10:00:0${second}.000Z`,
    message: { role, content },
  });
}

// Claude Code returns each tool result to the model as a user-role line.
const transcript = [
  line('user', 'Fix the build', 0),
  line('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm lint' } }], 1),
  line('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], 2),
  line('assistant', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.ts' } }], 3),
  line('user', [{ type: 'tool_result', tool_use_id: 't2', content: '...' }], 4),
  line('assistant', [{ type: 'text', text: 'Fixed.' }], 5),
  line('user', [{ type: 'text', text: 'Thanks, now run the tests' }], 6),
].join('\n');

test('a Claude user message is a prompt, not a tool result returned to the model', () => {
  const parsed = parseSessionMessages(transcript, 's1');
  assert.equal(parsed.metadata.message_count, 7);
  assert.equal(parsed.metadata.user_message_count, 2);
});

test('the data migration recounts stored Claude sessions the same way', () => {
  initSchema();
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  db.pragma('user_version = 21');

  db.prepare(`INSERT INTO browsing_sessions (id, agent, integration_mode, message_count, user_message_count)
    VALUES ('claude-s', 'claude', 'claude-jsonl', 4, 3), ('codex-s', 'codex', 'codex-jsonl', 2, 2)`).run();
  const message = db.prepare('INSERT INTO messages (session_id, ordinal, role, content) VALUES (?, ?, ?, ?)');
  message.run('claude-s', 0, 'user', JSON.stringify([{ type: 'text', text: 'Fix the build' }]));
  message.run('claude-s', 1, 'assistant', JSON.stringify([{ type: 'tool_use', id: 't1', name: 'Bash' }]));
  message.run('claude-s', 2, 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]));
  message.run('claude-s', 3, 'user', JSON.stringify([
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'text', text: 'and the tests' },
  ]));
  // Codex counts prompts already; its rows are left alone.
  message.run('codex-s', 0, 'user', JSON.stringify([{ type: 'text', text: 'hi' }]));

  runDataMigrations(db);

  const counts = Object.fromEntries((db.prepare('SELECT id, user_message_count FROM browsing_sessions').all() as Array<{
    id: string; user_message_count: number;
  }>).map(row => [row.id, row.user_message_count]));
  assert.deepEqual(counts, { 'claude-s': 2, 'codex-s': 2 });
});
