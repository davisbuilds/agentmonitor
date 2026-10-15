import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-title-migration-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema, runDataMigrations } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seed(): void {
  const db = getDb();
  const session = db.prepare(`
    INSERT INTO browsing_sessions (id, agent, first_message, file_path, parent_session_id, relationship_type, integration_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const watched = db.prepare(`
    INSERT INTO watched_files (file_path, file_hash, file_mtime, status) VALUES (?, 'hash', '2026-10-01', 'parsed')
  `);
  const claudeFile = '/Users/example/.claude/projects/-Users-example-app/top-1.jsonl';
  const subagentFile = '/Users/example/.claude/projects/-Users-example-app/top-1/subagents/agent-a9.jsonl';
  const codexFile = '/Users/example/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-0000.jsonl';
  const antigravityFile = '/Users/example/.gemini/antigravity/brain/ag-1.pb';
  session.run('top-1', 'claude', 'Fix it', claudeFile, null, null, 'claude-jsonl');
  session.run('agent-a9', 'claude', 'You are a helper', subagentFile, null, 'subagent', 'claude-jsonl');
  session.run('rollout-1', 'codex', '# AGENTS.md instructions for /app', codexFile, null, 'conversation', 'codex-jsonl');
  session.run('ag-1', 'antigravity', 'user input', antigravityFile, null, null, null);
  session.run('codex-job', 'codex', 'Generate a concise, single-line task title of at most 36 characters', null, null, null, 'codex-otel');
  session.run('codex-user', 'codex', 'Generate a title for the blog post', null, null, null, 'codex-otel');
  // An older layout kept subagent transcripts beside their parent's, not inside it.
  session.run('agent-old', 'claude', 'Legacy helper', '/Users/example/.claude/projects/-Users-example-app/agent-old.jsonl', null, 'subagent', 'claude-jsonl');
  session.run('codex-job-file', 'codex', 'Write a brief catch-up for a user returning to this task.', codexFile.replace('0000', '1111'), null, null, 'codex-jsonl');
  session.run('codex-sub', 'codex', 'Write a brief catch-up for a user returning to this task.', null, 'p', 'subagent', 'codex-otel');
  for (const file of [claudeFile, subagentFile, codexFile, antigravityFile]) watched.run(file);
}

test('v19 flags transcripts for reparse and corrects rows that cannot be reparsed', () => {
  const db = getDb();
  seed();
  db.pragma('user_version = 18');
  runDataMigrations(db);

  assert.equal(db.pragma('user_version', { simple: true }), 20);

  const hashes = Object.fromEntries((db.prepare('SELECT file_path, file_hash FROM watched_files').all() as Array<{
    file_path: string; file_hash: string;
  }>).map(row => [path.basename(row.file_path), row.file_hash]));
  assert.deepEqual(hashes, {
    'top-1.jsonl': '',
    'agent-a9.jsonl': '',
    'rollout-2026-10-01T10-00-00-0000.jsonl': '',
    'ag-1.pb': 'hash',
  }, 'Claude and Codex transcripts reparse; Antigravity is untouched');

  const rows = Object.fromEntries((db.prepare('SELECT id, parent_session_id, relationship_type FROM browsing_sessions').all() as Array<{
    id: string; parent_session_id: string | null; relationship_type: string | null;
  }>).map(row => [row.id, [row.parent_session_id, row.relationship_type]]));
  assert.deepEqual(rows['agent-a9'], ['top-1', 'subagent'], 'the subagent sits in its parent session folder');
  assert.deepEqual(rows['top-1'], [null, null]);
  assert.deepEqual(rows['codex-job'], [null, 'internal']);
  assert.deepEqual(rows['codex-user'], [null, null], 'a user prompt is not a Codex app job');
  assert.deepEqual(rows['agent-old'], [null, 'subagent'], 'no parent folder, no guessed parent');
  assert.deepEqual(rows['codex-job-file'], [null, null], 'a reparse decides rows that have a transcript');
  assert.deepEqual(rows['codex-sub'], ['p', 'subagent'], 'an existing classification is kept');
  assert.deepEqual(rows['rollout-1'], [null, 'conversation']);
});
