import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { runImport as runImportFn } from '../src/import/index.js';
import type {
  startWatcher as startWatcherFn,
  stopWatcher as stopWatcherFn,
} from '../src/watcher/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-claude-history-root-'));
const originalHome = process.env.HOME;
const originalClaudeDir = process.env.AGENTMONITOR_CLAUDE_DIR;
const originalCodexHome = process.env.CODEX_HOME;

const ambientHome = path.join(root, 'ambient-home');
const configuredClaudeDir = path.join(root, 'configured-claude');
const codexHome = path.join(root, 'codex');
const configuredSessionPath = path.join(
  configuredClaudeDir,
  'projects',
  'configured-project',
  'configured-session.jsonl',
);
const ambientSessionPath = path.join(
  ambientHome,
  '.claude',
  'projects',
  'ambient-project',
  'ambient-session.jsonl',
);

process.env.HOME = ambientHome;
process.env.AGENTMONITOR_CLAUDE_DIR = configuredClaudeDir;
process.env.CODEX_HOME = codexHome;
process.env.AGENTMONITOR_DB_PATH = path.join(root, 'agentmonitor.db');
process.env.AGENTMONITOR_AUTO_IMPORT_MINUTES = '0';

let closeDb: typeof closeDbFn;
let getDb: typeof getDbFn;
let runImport: typeof runImportFn;
let startWatcher: typeof startWatcherFn;
let stopWatcher: typeof stopWatcherFn;

function sessionJsonl(sessionId: string, projectDir: string): string {
  return [
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd: projectDir,
      message: { role: 'user', content: 'hello' },
      timestamp: '2026-07-29T10:00:00Z',
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      cwd: projectDir,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        model: 'claude-sonnet-4-6',
      },
      timestamp: '2026-07-29T10:00:01Z',
    }),
  ].join('\n');
}

before(async () => {
  fs.mkdirSync(path.dirname(configuredSessionPath), { recursive: true });
  fs.mkdirSync(path.dirname(ambientSessionPath), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.writeFileSync(configuredSessionPath, sessionJsonl('configured-session', '/work/configured'));
  fs.writeFileSync(ambientSessionPath, sessionJsonl('ambient-session', '/work/ambient'));

  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  ({ runImport } = await import('../src/import/index.js'));
  ({ startWatcher, stopWatcher } = await import('../src/watcher/service.js'));
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
});

after(async () => {
  await stopWatcher();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalClaudeDir === undefined) delete process.env.AGENTMONITOR_CLAUDE_DIR;
  else process.env.AGENTMONITOR_CLAUDE_DIR = originalClaudeDir;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

test('historical import reads the configured Claude history root', () => {
  const result = runImport({ source: 'claude-code', dryRun: true });

  assert.deepEqual(result.files.map(file => file.path), [configuredSessionPath]);
});

test('startup watcher includes the configured root and excludes ambient Claude history', () => {
  startWatcher();

  const rows = getDb().prepare(
    'SELECT id FROM browsing_sessions ORDER BY id',
  ).all() as Array<{ id: string }>;
  assert.deepEqual(rows, [{ id: 'configured-session' }]);
});
