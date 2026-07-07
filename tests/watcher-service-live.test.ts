import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before, describe } from 'node:test';

import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { startWatcher as startWatcherFn, stopWatcher as stopWatcherFn } from '../src/watcher/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-watcher-live-'));
process.env.AGENTMONITOR_DB_PATH = path.join(root, 'test.db');

const claudeDir = path.join(root, 'claude');
const codexHome = path.join(root, 'codex');
const antigravityDir = path.join(root, 'antigravity');
const projectDir = path.join(claudeDir, 'projects', '-proj');

let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let startWatcher: typeof startWatcherFn;
let stopWatcher: typeof stopWatcherFn;

function seedRow(id: string): void {
  getDb().prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata)
    VALUES (?, 'claude_code-default', 'claude_code', 'proj', 'main', 'active', datetime('now'), datetime('now'), '{}')
  `).run(id);
}

function modeOf(id: string): string | null {
  const row = getDb().prepare("SELECT json_extract(metadata, '$.mode') AS mode FROM sessions WHERE id = ?").get(id) as { mode: string | null } | undefined;
  return row?.mode ?? null;
}

before(async () => {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(antigravityDir, { recursive: true });

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const svc = await import('../src/watcher/service.js');
  startWatcher = svc.startWatcher;
  stopWatcher = svc.stopWatcher;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
});

after(() => {
  stopWatcher();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('watcher picks up live file changes (chokidar directory watch, not globs)', () => {
  test('a newly written headless JSONL is parsed and its session marked', async () => {
    const id = 'live-w-headless';
    seedRow(id);

    startWatcher({ claudeDir, codexHome, antigravityDir });
    // Give chokidar a moment to establish its watchers before writing.
    await delay(600);

    fs.writeFileSync(
      path.join(projectDir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', sessionId: id, entrypoint: 'sdk-cli', promptSource: 'sdk', cwd: '/tmp/proj',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, timestamp: '2026-07-07T10:00:00Z' }),
        JSON.stringify({ type: 'assistant', sessionId: id, entrypoint: 'sdk-cli', cwd: '/tmp/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'claude-haiku-4-5-20251001' }, timestamp: '2026-07-07T10:00:01Z' }),
      ].join('\n') + '\n',
    );

    // Poll up to ~5s: chokidar stabilityThreshold (300ms) + debounce (500ms) + parse.
    let mode: string | null = null;
    for (let i = 0; i < 50; i++) {
      mode = modeOf(id);
      if (mode !== null) break;
      await delay(100);
    }
    assert.equal(mode, 'headless');
  });
});
