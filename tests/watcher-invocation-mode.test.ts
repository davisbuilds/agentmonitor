import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';

import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type {
  syncSessionFileDetailed as syncSessionFileDetailedFn,
  syncCodexSessionFileDetailed as syncCodexSessionFileDetailedFn,
} from '../src/watcher/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-watcher-mode-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let syncSessionFileDetailed: typeof syncSessionFileDetailedFn;
let syncCodexSessionFileDetailed: typeof syncCodexSessionFileDetailedFn;

const claudeDir = path.join(tempDir, 'claude', 'projects', 'proj');
const codexDir = path.join(tempDir, 'codex', 'sessions');

function seedSessionRow(id: string, agentType: string): void {
  // Simulate the hook/OTEL-created Monitor session row the watcher patches.
  getDb().prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata)
    VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'), '{}')
  `).run(id, `${agentType}-default`, agentType, 'proj', 'main');
}

function modeOf(id: string): string | null {
  const row = getDb().prepare("SELECT json_extract(metadata, '$.mode') AS mode FROM sessions WHERE id = ?").get(id) as { mode: string | null } | undefined;
  return row?.mode ?? null;
}

function write(dir: string, name: string, lines: object[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

before(async () => {
  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const mod = await import('../src/watcher/index.js');
  syncSessionFileDetailed = mod.syncSessionFileDetailed;
  syncCodexSessionFileDetailed = mod.syncCodexSessionFileDetailed;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('watcher stamps invocation mode onto the live Monitor session', () => {
  test('headless Claude session (entrypoint sdk-cli) is marked on sync', () => {
    const id = 'w-cc-headless';
    seedSessionRow(id, 'claude_code');
    const file = write(claudeDir, `${id}.jsonl`, [
      { type: 'user', sessionId: id, entrypoint: 'sdk-cli', promptSource: 'sdk', cwd: '/tmp/proj',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, timestamp: '2026-07-07T10:00:00Z' },
      { type: 'assistant', sessionId: id, entrypoint: 'sdk-cli', cwd: '/tmp/proj',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-07-07T10:00:01Z' },
    ]);
    syncSessionFileDetailed(getDb(), file);
    assert.equal(modeOf(id), 'headless');
  });

  test('interactive Claude session (entrypoint cli) is marked on sync', () => {
    const id = 'w-cc-interactive';
    seedSessionRow(id, 'claude_code');
    const file = write(claudeDir, `${id}.jsonl`, [
      { type: 'user', sessionId: id, entrypoint: 'cli', promptSource: 'typed', cwd: '/tmp/proj',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, timestamp: '2026-07-07T10:00:00Z' },
      { type: 'assistant', sessionId: id, entrypoint: 'cli', cwd: '/tmp/proj',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-07-07T10:00:01Z' },
    ]);
    syncSessionFileDetailed(getDb(), file);
    assert.equal(modeOf(id), 'interactive');
  });

  test('headless Codex session (originator codex_exec) is marked on sync', () => {
    // Monitor rows are keyed by the session UUID; the rollout filename carries it.
    const uuid = '019c26c7-9c64-7b01-b7bb-695ce94c3237';
    seedSessionRow(uuid, 'codex');
    const file = write(codexDir, `rollout-2026-07-07T10-00-00-${uuid}.jsonl`, [
      { type: 'session_meta', timestamp: '2026-07-07T10:00:00Z',
        payload: { id: uuid, cwd: '/tmp/proj', originator: 'codex_exec', timestamp: '2026-07-07T10:00:00Z' } },
      { type: 'response_item', timestamp: '2026-07-07T10:00:01Z',
        payload: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'response_item', timestamp: '2026-07-07T10:00:02Z',
        payload: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    syncCodexSessionFileDetailed(getDb(), file);
    assert.equal(modeOf(uuid), 'headless');
  });

  test('does not create a Monitor session row when none exists (no hook/import yet)', () => {
    const id = 'w-cc-orphan';
    const file = write(claudeDir, `${id}.jsonl`, [
      { type: 'user', sessionId: id, entrypoint: 'sdk-cli', cwd: '/tmp/proj',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, timestamp: '2026-07-07T10:00:00Z' },
    ]);
    syncSessionFileDetailed(getDb(), file);
    const row = getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    assert.equal(row, undefined, 'watcher must not fabricate Monitor session rows');
  });
});
