import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { ParsedSession } from '../src/parser/claude-code.js';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let syncClaudeLiveSession: typeof import('../src/live/claude-adapter.js').syncClaudeLiveSession;
let syncCodexLiveSession: typeof import('../src/live/codex-adapter.js').syncCodexLiveSession;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-occupancy-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  ({ initSchema } = await import('../src/db/schema.js'));
  ({ syncClaudeLiveSession } = await import('../src/live/claude-adapter.js'));
  ({ syncCodexLiveSession } = await import('../src/live/codex-adapter.js'));

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function baseParsed(id: string, agent: string, extra: Partial<ParsedSession['metadata']>): ParsedSession {
  return {
    messages: [],
    toolCalls: [],
    metadata: {
      session_id: id,
      project: 'proj',
      agent,
      first_message: 'hi',
      started_at: '2026-07-07T10:00:00.000Z',
      ended_at: '2026-07-07T10:00:02.000Z',
      message_count: 0,
      user_message_count: 0,
      parent_session_id: null,
      relationship_type: null,
      ...extra,
    },
  };
}

function readOccupancy(id: string): { used: number | null; window: number | null } {
  const row = getDb()
    .prepare('SELECT context_used_tokens, context_window_tokens FROM browsing_sessions WHERE id = ?')
    .get(id) as { context_used_tokens: number | null; context_window_tokens: number | null } | undefined;
  return { used: row?.context_used_tokens ?? null, window: row?.context_window_tokens ?? null };
}

test('syncClaudeLiveSession persists occupancy with the 1M default window', () => {
  syncClaudeLiveSession(getDb(), baseParsed('claude-occ', 'claude', {
    context_used_tokens: 361_802,
    model: 'claude-opus-4-8',
  }));
  assert.deepEqual(readOccupancy('claude-occ'), { used: 361_802, window: 1_000_000 });
});

test('syncCodexLiveSession persists occupancy with the reported window', () => {
  syncCodexLiveSession(getDb(), baseParsed('codex-occ', 'codex', {
    context_used_tokens: 64_000,
    context_window_reported: 258_400,
  }));
  assert.deepEqual(readOccupancy('codex-occ'), { used: 64_000, window: 258_400 });
});

test('a session with no usage persists null occupancy (unavailable, not 0)', () => {
  syncClaudeLiveSession(getDb(), baseParsed('claude-none', 'claude', {}));
  assert.deepEqual(readOccupancy('claude-none'), { used: null, window: null });
});
