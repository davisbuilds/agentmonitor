import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('startup warns when a cached parsed transcript has no browsing projection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-projection-warning-'));
  const dbPath = path.join(root, 'test.db');
  const claudeDir = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  const antigravityDir = path.join(root, 'antigravity');
  const projectDir = path.join(claudeDir, 'projects', '-proj');
  const filePath = path.join(projectDir, 'missing-projection.jsonl');
  const content = `${JSON.stringify({
    type: 'user',
    sessionId: 'missing-projection',
    cwd: '/tmp/proj',
    message: { role: 'user', content: 'hello' },
    timestamp: '2026-07-14T10:00:00Z',
  })}\n`;

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(antigravityDir, { recursive: true });
  fs.writeFileSync(filePath, content);
  process.env.AGENTMONITOR_DB_PATH = dbPath;

  const { initSchema } = await import('../src/db/schema.js');
  const { closeDb, getDb } = await import('../src/db/connection.js');
  const { startWatcher, stopWatcher } = await import('../src/watcher/service.js');
  initSchema();

  getDb().prepare(`
    INSERT INTO watched_files (file_path, file_hash, file_mtime, status)
    VALUES (?, ?, ?, 'parsed')
  `).run(
    filePath,
    crypto.createHash('sha256').update(content).digest('hex'),
    new Date().toISOString(),
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    startWatcher({ claudeDir, codexHome, antigravityDir });
    assert.ok(warnings.some(message => (
      message.includes('1 cached Claude/Codex session file(s)')
      && message.includes('amon sync sessions --source all --force')
    )));
  } finally {
    console.warn = originalWarn;
    await stopWatcher();
    closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
