import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let parseSessionMessages: typeof import('../src/parser/claude-code.js').parseSessionMessages;
let insertParsedSession: typeof import('../src/parser/claude-code.js').insertParsedSession;
let syncClaudeLiveSession: typeof import('../src/live/claude-adapter.js').syncClaudeLiveSession;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-live-claude-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  ({ initSchema } = await import('../src/db/schema.js'));
  ({ parseSessionMessages, insertParsedSession } = await import('../src/parser/claude-code.js'));
  ({ syncClaudeLiveSession } = await import('../src/live/claude-adapter.js'));

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sampleJsonl(lines: object[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

function makeSession(sessionId: string, lines: object[]): string {
  return sampleJsonl(lines.map((line) => ({ sessionId, cwd: '/Users/dev/agentmonitor', ...line })));
}

test('syncClaudeLiveSession inserts one turn per new message and normalized items', () => {
  const db = getDb();
  const jsonl = makeSession('live-claude-001', [
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Inspect the repo' }] },
      timestamp: '2026-03-24T10:00:00.000Z',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Looking through files first' },
          { type: 'text', text: 'I am checking the parser now.' },
          { type: 'tool_use', id: 'toolu_live_001', name: 'Read', input: { file_path: '/Users/dev/agentmonitor/src/parser/claude-code.ts' } },
        ],
      },
      timestamp: '2026-03-24T10:00:05.000Z',
    },
  ]);

  const parsed = parseSessionMessages(jsonl, 'live-claude-001', '/tmp/live-claude-001.jsonl');
  insertParsedSession(db, parsed, '/tmp/live-claude-001.jsonl', 512, 'hash-live-1');
  const result = syncClaudeLiveSession(db, parsed);

  assert.equal(result.inserted_turns, 2);
  assert.equal(result.inserted_items, 4);

  const turns = db.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY id').all('live-claude-001') as Array<{ source_turn_id: string }>;
  const items = db.prepare('SELECT kind FROM session_items WHERE session_id = ? ORDER BY id').all('live-claude-001') as Array<{ kind: string }>;
  const session = db.prepare('SELECT integration_mode, fidelity, capabilities_json FROM browsing_sessions WHERE id = ?').get('live-claude-001') as {
    integration_mode: string | null;
    fidelity: string | null;
    capabilities_json: string | null;
  };
  const capabilities = JSON.parse(session.capabilities_json ?? '{}') as {
    history?: string;
    search?: string;
    tool_analytics?: string;
    live_items?: string;
  };

  assert.deepEqual(turns.map(turn => turn.source_turn_id), ['claude-message:0', 'claude-message:1']);
  assert.deepEqual(items.map(item => item.kind), ['user_message', 'reasoning', 'assistant_message', 'tool_call']);
  assert.equal(session.integration_mode, 'claude-jsonl');
  assert.equal(session.fidelity, 'full');
  assert.equal(capabilities.history, 'full');
  assert.equal(capabilities.search, 'full');
  assert.equal(capabilities.tool_analytics, 'full');
  assert.equal(capabilities.live_items, 'full');
});

test('syncClaudeLiveSession appends only new messages on re-sync', () => {
  const db = getDb();
  const jsonl1 = makeSession('live-claude-append', [
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'First prompt' }] },
      timestamp: '2026-03-24T10:10:00.000Z',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] },
      timestamp: '2026-03-24T10:10:05.000Z',
    },
  ]);
  const parsed1 = parseSessionMessages(jsonl1, 'live-claude-append', '/tmp/live-claude-append.jsonl');
  insertParsedSession(db, parsed1, '/tmp/live-claude-append.jsonl', 256, 'hash-append-1');
  const initial = syncClaudeLiveSession(db, parsed1);
  assert.equal(initial.inserted_turns, 2);

  const jsonl2 = makeSession('live-claude-append', [
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'First prompt' }] },
      timestamp: '2026-03-24T10:10:00.000Z',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] },
      timestamp: '2026-03-24T10:10:05.000Z',
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Second prompt' }] },
      timestamp: '2026-03-24T10:11:00.000Z',
    },
  ]);
  const parsed2 = parseSessionMessages(jsonl2, 'live-claude-append', '/tmp/live-claude-append.jsonl');
  insertParsedSession(db, parsed2, '/tmp/live-claude-append.jsonl', 384, 'hash-append-2');
  const appended = syncClaudeLiveSession(db, parsed2);

  assert.equal(appended.inserted_turns, 1);
  assert.equal(appended.inserted_items, 1);

  const turnCount = (db.prepare('SELECT COUNT(*) as c FROM session_turns WHERE session_id = ?').get('live-claude-append') as { c: number }).c;
  const itemCount = (db.prepare('SELECT COUNT(*) as c FROM session_items WHERE session_id = ?').get('live-claude-append') as { c: number }).c;
  assert.equal(turnCount, 3);
  assert.equal(itemCount, 3);
});

test('syncClaudeLiveSession redacts prompt, reasoning, and tool arguments when capture is disabled', () => {
  const db = getDb();
  const jsonl = makeSession('live-claude-redacted', [
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Secret prompt' }] },
      timestamp: '2026-03-24T11:00:00.000Z',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Sensitive reasoning' },
          { type: 'tool_use', id: 'toolu_live_redacted', name: 'Bash', input: { command: 'cat ~/.ssh/config' } },
        ],
      },
      timestamp: '2026-03-24T11:00:04.000Z',
    },
  ]);

  const parsed = parseSessionMessages(jsonl, 'live-claude-redacted', '/tmp/live-claude-redacted.jsonl');
  insertParsedSession(db, parsed, '/tmp/live-claude-redacted.jsonl', 512, 'hash-redacted-1');
  syncClaudeLiveSession(db, parsed, {
    privacyPolicy: {
      capturePrompts: false,
      captureReasoning: false,
      captureToolArguments: false,
      diffPayloadMaxBytes: 1024,
    },
  });

  const items = db.prepare('SELECT kind, payload_json FROM session_items WHERE session_id = ? ORDER BY id').all('live-claude-redacted') as Array<{ kind: string; payload_json: string }>;

  assert.equal(items.length, 3);

  const promptPayload = JSON.parse(items[0].payload_json) as { redacted?: boolean; reason?: string };
  const reasoningPayload = JSON.parse(items[1].payload_json) as { redacted?: boolean; reason?: string };
  const toolPayload = JSON.parse(items[2].payload_json) as { input?: unknown; input_redacted?: boolean };

  assert.equal(items[0].kind, 'user_message');
  assert.equal(promptPayload.redacted, true);
  assert.equal(promptPayload.reason, 'prompt_capture_disabled');

  assert.equal(items[1].kind, 'reasoning');
  assert.equal(reasoningPayload.redacted, true);
  assert.equal(reasoningPayload.reason, 'reasoning_capture_disabled');

  assert.equal(items[2].kind, 'tool_call');
  assert.deepEqual(toolPayload.input, { redacted: true });
  assert.equal(toolPayload.input_redacted, true);
});
