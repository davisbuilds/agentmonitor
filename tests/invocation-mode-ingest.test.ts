import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import type { insertEvent as insertEventType } from '../src/db/queries.js';
import type { listMonitorSessions as listMonitorSessionsType } from '../src/db/v2-queries.js';
import type { parseClaudeCodeFile as parseClaudeCodeFileType } from '../src/import/claude-code.js';
import type { parseCodexFile as parseCodexFileType } from '../src/import/codex.js';

// Env must be set before any module that snapshots config is imported.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-invocation-mode-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_SESSION_TIMEOUT = '1000000';

let closeDb: () => void;
let insertEvent: typeof insertEventType;
let listMonitorSessions: typeof listMonitorSessionsType;
let parseClaudeCodeFile: typeof parseClaudeCodeFileType;
let parseCodexFile: typeof parseCodexFileType;

function writeJsonl(name: string, lines: unknown[]): string {
  const p = path.join(tempDir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

function modeFor(sessionId: string): string | null {
  const { sessions } = listMonitorSessions({ limit: 0 });
  const row = sessions.find((s) => s.id === sessionId);
  assert.ok(row, `session ${sessionId} present`);
  return (row as { mode: string | null }).mode;
}

before(async () => {
  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  insertEvent = (await import('../src/db/queries.js')).insertEvent;
  listMonitorSessions = (await import('../src/db/v2-queries.js')).listMonitorSessions;
  parseClaudeCodeFile = (await import('../src/import/claude-code.js')).parseClaudeCodeFile;
  parseCodexFile = (await import('../src/import/codex.js')).parseCodexFile;
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('invocation mode surfaces on monitor sessions', () => {
  test('headless Claude session (entrypoint sdk-cli) → mode headless', () => {
    const file = writeJsonl('cc-headless.jsonl', [
      {
        type: 'assistant',
        sessionId: 'cc-headless',
        entrypoint: 'sdk-cli',
        promptSource: 'sdk',
        cwd: '/tmp/proj',
        timestamp: '2026-07-07T10:00:00Z',
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);
    for (const e of parseClaudeCodeFile(file)) insertEvent(e);
    assert.equal(modeFor('cc-headless'), 'headless');
  });

  test('interactive Claude session (entrypoint cli) → mode interactive', () => {
    const file = writeJsonl('cc-interactive.jsonl', [
      {
        type: 'assistant',
        sessionId: 'cc-interactive',
        entrypoint: 'cli',
        promptSource: 'typed',
        cwd: '/tmp/proj',
        timestamp: '2026-07-07T10:00:00Z',
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);
    for (const e of parseClaudeCodeFile(file)) insertEvent(e);
    assert.equal(modeFor('cc-interactive'), 'interactive');
  });

  test('headless Codex session (originator codex_exec) → mode headless', () => {
    const file = writeJsonl('rollout-cdx-headless.jsonl', [
      {
        timestamp: '2026-07-07T10:00:00Z',
        type: 'session_meta',
        payload: { id: 'cdx-headless', cwd: '/tmp/proj', originator: 'codex_exec', timestamp: '2026-07-07T10:00:00Z' },
      },
      {
        timestamp: '2026-07-07T10:00:01Z',
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    for (const e of parseCodexFile(file)) insertEvent(e);
    assert.equal(modeFor('cdx-headless'), 'headless');
  });

  test('interactive Codex session (originator codex-tui) → mode interactive', () => {
    const file = writeJsonl('rollout-cdx-tui.jsonl', [
      {
        timestamp: '2026-07-07T10:00:00Z',
        type: 'session_meta',
        payload: { id: 'cdx-tui', cwd: '/tmp/proj', originator: 'codex-tui', timestamp: '2026-07-07T10:00:00Z' },
      },
    ]);
    for (const e of parseCodexFile(file)) insertEvent(e);
    assert.equal(modeFor('cdx-tui'), 'interactive');
  });
});
