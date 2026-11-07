import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-project-repair-lock-')));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { renameStoredProjects, repairProjectNames } = await import('../src/import/project-repair.js');
const { setScratchRootsForTests } = await import('../src/util/project-identity.js');
setScratchRootsForTests([]);

// A Claude transcript whose cwd basename is already its project, so the repair's
// first statement reads the browser row before it writes.
const CLAUDE_ID = 'c0ffee00-0000-4000-8000-0000000000aa';
const repo = path.join(tempDir, 'Dev', 'app');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
const claudeDir = path.join(tempDir, 'claude');

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  const file = path.join(claudeDir, 'projects', '-Dev-app', `${CLAUDE_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, cwd: repo, message: { role: 'user', content: 'hi' } }));
  getDb().prepare('INSERT INTO browsing_sessions (id, agent, project) VALUES (?, ?, ?)').run(CLAUDE_ID, 'claude', 'Dev-app');
  getDb().prepare(`INSERT INTO events (session_id, agent_type, event_type, status, project, source, created_at)
    VALUES ('job', 'claude_code', 'response', 'success', 'old-name', 'import', '2026-05-18 10:00:00')`).run();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Another process (the running server, in practice) takes the write lock and
 * commits a write shortly after, while the repair runs. Resolves once it holds
 * the lock; `committed` settles once it has committed and exited. (Wrapped in
 * an object: an async function returning a promise would wait for it.)
 */
async function writerCommittingSoon(): Promise<{ committed: Promise<void> }> {
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(process.env.AGENTMONITOR_DB_PATH)}, { timeout: 30000 });
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO events (session_id, agent_type, event_type, status, source) VALUES ('server', 'codex', 'response', 'success', 'otel')").run();
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec('COMMIT');
    db.close();
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve(); });
    child.on('exit', code => reject(new Error(`writer exited ${code} before locking`)));
  });
  return { committed: exited };
}

test('a listed rename waits for a server write instead of failing as locked', async () => {
  const { committed } = await writerCommittingSoon();
  const report = renameStoredProjects(getDb(), { names: [['old-name', 'new-name']], apply: false });
  await committed;
  assert.deepEqual(report.rows, { events: 1, sessions: 0, browsing_sessions: 0 });
});

test('the transcript repair waits for a server write instead of failing as locked', async () => {
  const { committed } = await writerCommittingSoon();
  const report = repairProjectNames(getDb(), { claudeDir, codexDir: path.join(tempDir, 'codex'), apply: false });
  await committed;
  assert.deepEqual(report.rows, { events: 0, sessions: 0, browsing_sessions: 1 });
});
