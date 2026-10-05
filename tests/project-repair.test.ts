import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-project-repair-')));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { repairProjectNames } = await import('../src/import/project-repair.js');
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');

// A repo with a worktree that has since been removed, as transcripts outlive them.
const dev = path.join(tempDir, 'Dev');
const repo = path.join(dev, 'app');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
const goneWorktree = path.join(dev, '.worktrees', 'app-task');
const plain = path.join(dev, 'notes');
fs.mkdirSync(plain, { recursive: true });

const claudeDir = path.join(tempDir, 'claude');
const codexDir = path.join(tempDir, 'codex');
const CLAUDE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const CODEX_ID = '01a0a5aa-cc7f-7b91-a14c-ffda7ce66b47';
const ROLLOUT = `rollout-2026-10-05T10-00-00-${CODEX_ID}`;

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));

  // Claude transcript: the encoded folder name is the one the old decoder misread.
  const claudeFile = path.join(claudeDir, 'projects', '-Users-dg-mac-mini-Dev', `${CLAUDE_ID}.jsonl`);
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, [
    { type: 'user', sessionId: CLAUDE_ID, cwd: goneWorktree, timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: 'hi' } },
    { type: 'user', sessionId: CLAUDE_ID, cwd: plain, timestamp: '2026-10-05T10:01:00Z', message: { role: 'user', content: 'there' } },
  ].map(line => JSON.stringify(line)).join('\n'));

  const codexFile = path.join(codexDir, 'sessions', '2026', '10', '05', `${ROLLOUT}.jsonl`);
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: CODEX_ID, cwd: goneWorktree, source: 'cli' } }));

  const db = getDb();
  const event = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, status, project, source, created_at)
    VALUES (?, ?, 'response', 'success', ?, ?, '2026-10-05 10:00:00')`);
  event.run(CLAUDE_ID, 'claude_code', 'app-task', 'import');
  event.run(CLAUDE_ID, 'claude_code', 'app-task', 'hook');
  event.run(CLAUDE_ID, 'claude_code', 'notes', 'import');
  event.run(CODEX_ID, 'codex', 'app-task', 'import');
  event.run(CODEX_ID, 'codex', null, 'otel');
  event.run('other-session', 'codex', 'app-task', 'import');
  db.prepare(`INSERT INTO sessions (id, agent_id, agent_type, project, status, last_event_at) VALUES (?, 'a', ?, ?, 'ended', '2026-10-05 10:00:00')`)
    .run(CLAUDE_ID, 'claude_code', 'app-task');
  db.prepare(`INSERT INTO sessions (id, agent_id, agent_type, project, status, last_event_at) VALUES (?, 'a', ?, ?, 'ended', '2026-10-05 10:00:00')`)
    .run(CODEX_ID, 'codex', 'app-task');
  const browser = db.prepare('INSERT INTO browsing_sessions (id, agent, project) VALUES (?, ?, ?)');
  browser.run(CLAUDE_ID, 'claude', 'mac-mini-Dev');
  browser.run(ROLLOUT, 'codex', 'app-task');
  browser.run(CODEX_ID, 'codex', 'app-task');
  for (const id of [CLAUDE_ID, ROLLOUT, CODEX_ID]) maintainSessionTraceSummary(id);
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const projects = (table: string, where = '1') => getDb().prepare(`SELECT project FROM ${table} WHERE ${where} ORDER BY rowid`).all()
  .map(row => (row as { project: string | null }).project);

test('a preview reports the renames and writes nothing', () => {
  const report = repairProjectNames(getDb(), { claudeDir, codexDir, apply: false });
  assert.equal(report.apply, false);
  assert.equal(report.transcripts_scanned, 2);
  assert.deepEqual(report.rows, { events: 3, sessions: 2, browsing_sessions: 3 });
  assert.deepEqual(projects('events'), ['app-task', 'app-task', 'notes', 'app-task', null, 'app-task']);
  assert.deepEqual(projects('browsing_sessions'), ['mac-mini-Dev', 'app-task', 'app-task']);
});

test('applying renames every table to the canonical project, once', () => {
  const report = repairProjectNames(getDb(), { claudeDir, codexDir, apply: true });
  assert.equal(report.sessions_changed, 2);
  assert.deepEqual(report.rows, { events: 3, sessions: 2, browsing_sessions: 3 });
  // Hook and import rows follow their cwd; another session and an OTEL row without one stay.
  assert.deepEqual(projects('events'), ['app', 'app', 'notes', 'app', null, 'app-task']);
  assert.deepEqual(projects('sessions'), ['app', 'app']);
  // The Claude browser row takes the transcript's first cwd.
  assert.deepEqual(projects('browsing_sessions'), ['app', 'app', 'app']);
  assert.deepEqual(projects('session_trace_summary', `session_id IN ('${CLAUDE_ID}', '${ROLLOUT}', '${CODEX_ID}')`), ['app', 'app', 'app']);
  assert.ok(report.renames.some(rename => rename.from === 'mac-mini-Dev' && rename.to === 'app'));

  const again = repairProjectNames(getDb(), { claudeDir, codexDir, apply: true });
  assert.deepEqual(again.rows, { events: 0, sessions: 0, browsing_sessions: 0 });
  assert.equal(again.sessions_changed, 0);
});
