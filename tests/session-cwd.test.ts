import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-cwd-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const { insertParsedSession, parseSessionChunk } = await import('../src/parser/claude-code.js');
const { parseCodexSessionChunk } = await import('../src/parser/codex-sessions.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
const storedCwd = (id: string) => (db.prepare('SELECT cwd FROM browsing_sessions WHERE id = ?').get(id) as { cwd: string | null }).cwd;
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');

test('a Claude session keeps the directory it started in, across a continued parse', () => {
  const first = lines([
    { type: 'user', uuid: 'u1', cwd: '/work/alpha', timestamp: '2026-03-02T10:00:00Z', message: { role: 'user', content: 'Fix the parser' } },
  ]);
  const chunk = parseSessionChunk(first, 'claude-1', '/home/.claude/projects/-work-alpha/claude-1.jsonl');
  assert.equal(chunk.parsed.metadata.cwd, '/work/alpha');
  insertParsedSession(db, chunk.parsed, '/home/.claude/projects/-work-alpha/claude-1.jsonl', 1, 'h1');
  assert.equal(storedCwd('claude-1'), '/work/alpha');

  // The session moved into a worktree later; it still started in alpha.
  const more = lines([
    { type: 'user', uuid: 'u2', cwd: '/work/.worktrees/alpha-fix', timestamp: '2026-03-02T10:05:00Z', message: { role: 'user', content: 'Now the tests' } },
  ]);
  const next = parseSessionChunk(more, 'claude-1', '/home/.claude/projects/-work-alpha/claude-1.jsonl', chunk.state);
  assert.equal(next.parsed.metadata.cwd, '/work/alpha');
});

test('a Codex rollout keeps the directory its session_meta names, across a continued parse', () => {
  const id = '01990000-0000-7000-8000-000000000001';
  const rolloutId = `rollout-2026-03-03T09-00-00-${id}`;
  const first = lines([
    { type: 'session_meta', timestamp: '2026-03-03T09:00:00Z', payload: { id, cwd: '/work/beta', timestamp: '2026-03-03T09:00:00Z', source: 'cli' } },
  ]);
  const chunk = parseCodexSessionChunk(first, rolloutId, `/home/.codex/sessions/${rolloutId}.jsonl`);
  assert.equal(chunk.parsed.metadata.cwd, '/work/beta');
  insertParsedSession(db, chunk.parsed, `/home/.codex/sessions/${rolloutId}.jsonl`, 1, 'h2');
  assert.equal(storedCwd(rolloutId), '/work/beta');

  const more = lines([
    { type: 'response_item', timestamp: '2026-03-03T09:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port it' }] } },
  ]);
  const next = parseCodexSessionChunk(more, rolloutId, `/home/.codex/sessions/${rolloutId}.jsonl`, chunk.state);
  assert.equal(next.parsed.metadata.cwd, '/work/beta');
});
