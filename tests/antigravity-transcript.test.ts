import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import Database from 'better-sqlite3';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { syncAntigravityLiveSession as syncAgrLiveFn } from '../src/live/antigravity-adapter.js';
import type { parseAntigravitySessions as parseAgrFn } from '../src/parser/antigravity-sessions.js';
import type {
  extractAntigravitySystemText as extractSystemTextFn,
  extractAntigravityUserText as extractUserTextFn,
  parseAntigravityTranscript as parseTranscriptFn,
  resolveAntigravityTranscriptPath as resolveTranscriptPathFn,
} from '../src/parser/antigravity-transcript.js';
import type {
  hashAntigravityDb as hashAgrDbFn,
  syncAllAntigravityFiles as syncAllAgrFn,
  syncAntigravitySessionFileDetailed as syncAgrDetailedFn,
} from '../src/watcher/index.js';
import type { getDailyConversationActivity as dailyActivityFn, getLiveSession as getLiveSessionFn, searchMessages as searchMessagesFn } from '../src/db/v2-queries.js';

function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let b = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) b |= 0x80;
    out.push(b);
  } while (big > 0);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const vField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];
const lField = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const sField = (f: number, s: string) => lField(f, [...Buffer.from(s, 'utf-8')]);
const stepBlob = (type: number, oneof: number) =>
  Buffer.from([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, [...vField(1, 1)])]);
const metaBlob = (secs: number) => Buffer.from(lField(1, [...vField(1, secs)]));
const genBlob = (model: string, sys: number, inp: number, cached: number) =>
  Buffer.from(lField(1, [
    ...sField(19, model),
    ...lField(4, [...vField(1, sys), ...vField(2, inp), ...vField(3, 50), ...vField(5, cached), ...vField(9, 0), ...vField(10, 50)]),
  ]));

function writeConversationDb(
  dbPath: string,
  options: {
    steps?: Array<{ idx: number; type: number; oneof: number; tsSecs: number }>;
    generations?: Array<{ model: string; sys: number; inp: number; cached: number }>;
  } = {},
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER, data BLOB);');
  db.exec('DELETE FROM steps; DELETE FROM gen_metadata;');
  const steps = options.steps ?? [{ idx: 0, type: 14, oneof: 19, tsSecs: 1782000000 }];
  const insStep = db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
  for (const s of steps) {
    insStep.run(s.idx, s.type, 3, stepBlob(s.type, s.oneof), metaBlob(s.tsSecs));
  }
  const insGen = db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
  (options.generations ?? []).forEach((g, idx) => {
    insGen.run(idx, genBlob(g.model, g.sys, g.inp, g.cached));
  });
  db.close();
}

function writeSummaryDb(
  home: string,
  rows: Array<{
    conversation_id: string;
    title?: string;
    preview?: string;
    workspace_uris?: string;
    parent_conversation_id?: string;
  }>,
): void {
  const summaryPath = path.join(home, 'conversation_summaries.db');
  const db = new Database(summaryPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      parent_conversation_id TEXT NOT NULL DEFAULT ''
    );
    DELETE FROM conversation_summaries;
  `);
  const ins = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, parent_conversation_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    ins.run(
      r.conversation_id,
      r.title ?? '',
      r.preview ?? '',
      r.workspace_uris ?? '[]',
      r.parent_conversation_id ?? '',
    );
  }
  db.close();
}

function writeTranscript(
  home: string,
  sessionId: string,
  entries: Array<Record<string, unknown> | string>,
  fileName: 'transcript_full.jsonl' | 'transcript.jsonl' = 'transcript_full.jsonl',
): string {
  const filePath = path.join(home, 'brain', sessionId, '.system_generated', 'logs', fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = entries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf-8');
  return filePath;
}

let tempDir = '';
let server: Server;
let baseUrl = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let parseAntigravitySessions: typeof parseAgrFn;
let resolveAntigravityTranscriptPath: typeof resolveTranscriptPathFn;
let extractAntigravitySystemText: typeof extractSystemTextFn;
let extractAntigravityUserText: typeof extractUserTextFn;
let parseAntigravityTranscript: typeof parseTranscriptFn;
let syncAntigravityLiveSession: typeof syncAgrLiveFn;
let hashAntigravityDb: typeof hashAgrDbFn;
let syncAntigravitySessionFileDetailed: typeof syncAgrDetailedFn;
let syncAllAntigravityFiles: typeof syncAllAgrFn;
let searchMessages: typeof searchMessagesFn;
let getLiveSession: typeof getLiveSessionFn;
let getDailyConversationActivity: typeof dailyActivityFn;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-transcript-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'monitor.db');
  process.env.AGENTMONITOR_TIMEZONE = 'UTC';

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();

  ({ parseAntigravitySessions } = await import('../src/parser/antigravity-sessions.js'));
  ({
    resolveAntigravityTranscriptPath,
    extractAntigravitySystemText,
    extractAntigravityUserText,
    parseAntigravityTranscript,
  } = await import('../src/parser/antigravity-transcript.js'));
  ({ syncAntigravityLiveSession } = await import('../src/live/antigravity-adapter.js'));
  ({
    hashAntigravityDb,
    syncAntigravitySessionFileDetailed,
    syncAllAntigravityFiles,
  } = await import('../src/watcher/index.js'));
  ({
    searchMessages,
    getLiveSession,
    getDailyConversationActivity,
  } = await import('../src/db/v2-queries.js'));

  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Antigravity full-fidelity transcript parser and FTS search', () => {
  test('resolveAntigravityTranscriptPath prefers transcript_full.jsonl and falls back to transcript.jsonl when absent or empty', () => {
    const direct = '/Users/example/.gemini/antigravity-cli/conversations/abc-123.db';
    assert.equal(
      resolveAntigravityTranscriptPath(direct),
      '/Users/example/.gemini/antigravity-cli/brain/abc-123/.system_generated/logs/transcript_full.jsonl',
    );
    const nested = '/Users/example/.gemini/antigravity-cli/conversations/nested/def-456.db';
    assert.equal(
      resolveAntigravityTranscriptPath(nested),
      '/Users/example/.gemini/antigravity-cli/brain/def-456/.system_generated/logs/transcript_full.jsonl',
    );

    const home = path.join(tempDir, 'agr-resolve-order');
    const id = '10101010-aaaa-bbbb-cccc-101010101010';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    const compactPath = writeTranscript(home, id, [{ type: 'USER_INPUT', content: 'hi' }], 'transcript.jsonl');
    assert.equal(resolveAntigravityTranscriptPath(dbPath), compactPath);

    const emptyFullPath = path.join(home, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
    fs.writeFileSync(emptyFullPath, '');
    assert.equal(resolveAntigravityTranscriptPath(dbPath), compactPath, 'empty transcript_full.jsonl falls back to transcript.jsonl');

    fs.writeFileSync(emptyFullPath, '{"type":"USER_INPUT","content":"full"}\n');
    assert.equal(resolveAntigravityTranscriptPath(dbPath), emptyFullPath, 'non-empty transcript_full.jsonl takes priority');
  });

  test('extractAntigravityUserText strips XML wrappers linearly without polynomial regex backtracking', () => {
    const wrapped = [
      '<USER_REQUEST>',
      'Inspect the FTS5 trigger behavior',
      'across multi-line prompts.',
      '</USER_REQUEST>',
      '<ADDITIONAL_METADATA>',
      'The current local time is: 2026-11-26T00:00:00-05:00.',
      '</ADDITIONAL_METADATA>',
      '<USER_SETTINGS_CHANGE>',
      'The user changed setting `Model Selection`.',
      '</USER_SETTINGS_CHANGE>',
    ].join('\n');
    assert.equal(
      extractAntigravityUserText(wrapped),
      'Inspect the FTS5 trigger behavior\nacross multi-line prompts.',
    );

    const unclosed = '<USER_REQUEST>\nTruncated long prompt without closing tag';
    assert.equal(extractAntigravityUserText(unclosed), 'Truncated long prompt without closing tag');

    const plainWithMeta = 'Plain prompt text\n<ADDITIONAL_METADATA>\ntime=now\n</ADDITIONAL_METADATA>';
    assert.equal(extractAntigravityUserText(plainWithMeta), 'Plain prompt text');

    const adversarial = '<USER_REQUEST>'.repeat(5000) + 'payload' + '<ADDITIONAL_METADATA>'.repeat(5000);
    const started = performance.now();
    const extracted = extractAntigravityUserText(adversarial);
    assert.ok(performance.now() - started < 100);
    assert.ok(extracted.includes('payload'));
  });

  test('parses full transcript messages, thinking, unwrapped tool calls, linked tool results, and metadata fallback', () => {
    const home = path.join(tempDir, 'agr-full');
    const sessionId = '11111111-aaaa-bbbb-cccc-222222222222';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbPath, { generations: [] });
    writeSummaryDb(home, [{
      conversation_id: sessionId,
      title: '',
      preview: '',
      workspace_uris: JSON.stringify(['file:///Users/example/Dev/sample-project']),
    }]);

    const hugeOutput = 'x'.repeat(20_000);
    const transcriptPath = writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T04:00:00Z',
        content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] Wakeup notification from subagent\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T04:00:01Z',
        content: '<USER_REQUEST>\nAudit quantum parser latency\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal_time=now\n</ADDITIONAL_METADATA>',
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'CONVERSATION_HISTORY',
        status: 'DONE',
        created_at: '2026-11-26T04:00:01Z',
      },
      {
        step_index: 3,
        source: 'SYSTEM',
        type: 'EPHEMERAL_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T04:00:01Z',
        content: '<EPHEMERAL_MESSAGE>reminder noise</EPHEMERAL_MESSAGE>',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T04:00:02Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 1200,
        cache_read_tokens: 4800,
        output_tokens: 150,
        thinking: 'Checking the parser and running tests first.',
        content: 'Let me inspect the parser and run the check.',
        tool_calls: [
          {
            id: 'call-read-4',
            name: 'read_file',
            args: {
              Path: '"/Users/example/Dev/sample-project/src/parser.ts"',
              StartLine: '1',
              EndLine: '50',
              RawBad: '"unterminated',
            },
          },
          {
            name: 'run_command',
            args: {
              CommandLine: '"pnpm test"',
              BypassSandbox: 'false',
            },
          },
        ],
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'GENERIC',
        call_id: 'call-read-4',
        status: 'DONE',
        created_at: '2026-11-26T04:00:03Z',
        content: `File contents: ${hugeOutput}`,
      },
      {
        step_index: 6,
        source: 'MODEL',
        type: 'RUN_COMMAND',
        status: 'ERROR',
        error: 'Command failed with exit code 1',
        created_at: '2026-11-26T04:00:04Z',
        content: 'Created At: 2026-11-26T04:00:04Z\nEncountered error in step execution: Command failed with exit code 1',
      },
      {
        step_index: 7,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        status: 'DONE',
        created_at: '2026-11-26T04:00:05Z',
        content: '{{ CHECKPOINT 0 }} summary noise',
      },
      {
        step_index: 9,
        source: 'MODEL',
        type: 'FINISH',
        status: 'DONE',
        created_at: '2026-11-26T04:00:07Z',
        content: 'Task finished cleanly.',
      },
      {
        step_index: 8,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T04:00:06Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 2000,
        cache_read_tokens: 6000,
        output_tokens: 80,
        content: 'All checks done.',
        tool_calls: [{ name: 'finish', args: { status: '"ok"' } }],
      },
    ]);

    const direct = parseAntigravityTranscript(transcriptPath, sessionId);
    assert.ok(direct, 'direct transcript parse returns result');

    const parsed = parseAntigravitySessions(dbPath);
    assert.equal(parsed.metadata.fidelity, 'full');
    assert.equal(parsed.metadata.project, 'sample-project');
    assert.equal(parsed.metadata.first_message, 'Audit quantum parser latency');
    assert.equal(parsed.metadata.user_message_count, 1, 'SYSTEM_MESSAGE and tool results do not inflate user_message_count');
    assert.equal(parsed.metadata.model, 'gemini-4-neon-xhigh');
    assert.equal(parsed.metadata.context_used_tokens, 8000, 'falls back to latest PLANNER_RESPONSE input + cache_read tokens');
    assert.equal(parsed.metadata.started_at, '2026-11-26T04:00:00.000Z');
    assert.equal(parsed.metadata.ended_at, '2026-11-26T04:00:07.000Z');

    assert.equal(parsed.toolCalls.length, 3);
    assert.equal(parsed.toolCalls[0].tool_name, 'read_file');
    assert.equal(parsed.toolCalls[0].category, 'Read');
    assert.deepEqual(JSON.parse(parsed.toolCalls[0].input_json!), {
      Path: '/Users/example/Dev/sample-project/src/parser.ts',
      StartLine: 1,
      EndLine: 50,
      RawBad: '"unterminated',
    });
    assert.equal(parsed.toolCalls[1].tool_name, 'run_command');
    assert.equal(parsed.toolCalls[1].category, 'Bash');
    assert.equal(parsed.toolCalls[2].tool_name, 'finish');
    assert.equal(parsed.toolCalls[2].category, 'Other');

    const roles = parsed.messages.map(m => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'user', 'user', 'assistant', 'user']);
    assert.deepEqual(JSON.parse(parsed.messages[0].content), [
      { type: 'text', text: '[Message] Wakeup notification from subagent' },
    ]);

    const plannerMsg = parsed.messages[2];
    assert.equal(plannerMsg.has_thinking, 1);
    assert.equal(plannerMsg.has_tool_use, 1);
    const plannerBlocks = JSON.parse(plannerMsg.content) as Array<Record<string, unknown>>;
    assert.equal(plannerBlocks[0].type, 'thinking');
    assert.equal(plannerBlocks[0].thinking, 'Checking the parser and running tests first.');
    assert.equal(plannerBlocks[1].type, 'text');
    assert.equal(plannerBlocks[1].text, 'Let me inspect the parser and run the check.');
    assert.equal(plannerBlocks[2].type, 'tool_use');
    assert.equal(plannerBlocks[2].name, 'read_file');
    assert.equal(plannerBlocks[3].type, 'tool_use');
    assert.equal(plannerBlocks[3].name, 'run_command');

    const readResultBlocks = JSON.parse(parsed.messages[3].content) as Array<Record<string, unknown>>;
    assert.equal(readResultBlocks[0].type, 'tool_result');
    assert.equal(readResultBlocks[0].tool_use_id, parsed.toolCalls[0].tool_use_id);
    assert.equal(readResultBlocks[0].is_error, false);
    assert.equal(readResultBlocks[0].content, `File contents: ${hugeOutput}`, 'preserves full tool output without artificial Antigravity cap');

    const cmdErrorBlocks = JSON.parse(parsed.messages[4].content) as Array<Record<string, unknown>>;
    assert.equal(cmdErrorBlocks[0].type, 'tool_result');
    assert.equal(cmdErrorBlocks[0].tool_use_id, parsed.toolCalls[1].tool_use_id);
    assert.equal(cmdErrorBlocks[0].is_error, true);

    const finishResultBlocks = JSON.parse(parsed.messages[6].content) as Array<Record<string, unknown>>;
    assert.equal(finishResultBlocks[0].type, 'tool_result');
    assert.equal(finishResultBlocks[0].tool_use_id, parsed.toolCalls[2].tool_use_id);
  });

  test('clears pending tool calls across ERROR_MESSAGE / new PLANNER_RESPONSE and preserves summary title when present', () => {
    const home = path.join(tempDir, 'agr-title-error');
    const sessionId = '33333333-aaaa-bbbb-cccc-444444444444';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbPath, {
      generations: [{ model: 'gemini-4-neon', sys: 500, inp: 1500, cached: 3000 }],
    });
    writeSummaryDb(home, [{
      conversation_id: sessionId,
      title: 'Canonical Summary Title',
      preview: 'Summary preview',
      workspace_uris: JSON.stringify(['file:///Users/example/Dev/agentmonitor']),
    }]);
    writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T05:00:00Z',
        content: '<USER_REQUEST>\nRaw first user prompt\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T05:00:01Z',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/tmp/missing"' } }],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'ERROR_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T05:00:02Z',
        error: 'invalid tool call',
        content: 'Error invalid tool call',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T05:00:03Z',
        content: 'Recovered cleanly.',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T05:00:04Z',
        content: 'Unpaired generic message',
      },
    ]);

    const parsed = parseAntigravitySessions(dbPath);
    assert.equal(parsed.metadata.title, 'Canonical Summary Title');
    assert.equal(parsed.metadata.first_message, 'Canonical Summary Title');
    assert.equal(parsed.metadata.context_used_tokens, 5000, 'gen_metadata wins over transcript usage');
    assert.equal(parsed.metadata.model, 'gemini-4-neon');

    const lastBlocks = JSON.parse(parsed.messages.at(-1)!.content) as Array<Record<string, unknown>>;
    assert.equal(lastBlocks[0].type, 'tool_result');
    assert.equal(lastBlocks[0].tool_use_id, undefined, 'unpaired GENERIC does not mis-link to cleared view_file call');
  });

  test('extracts SYSTEM_MESSAGE bodies cleanly across preamble, multi-block, bare, and inner-mention shapes', () => {
    const home = path.join(tempDir, 'agr-system-variants');
    const sessionId = '44444444-aaaa-bbbb-cccc-555555555555';
    const transcriptPath = writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T05:10:00Z',
        content: [
          'The following is a <SYSTEM_MESSAGE> not actually sent by the user.',
          '',
          '<SYSTEM_MESSAGE>',
          'First notification body',
          '</SYSTEM_MESSAGE>',
          '',
          '<SYSTEM_MESSAGE>',
          'Second notification body',
          '</SYSTEM_MESSAGE>',
        ].join('\n'),
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T05:10:01Z',
        content: '<SYSTEM_MESSAGE>\nBare notification without preamble\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T05:10:02Z',
        content: [
          'The following is a <SYSTEM_MESSAGE> not actually sent by the user.',
          '',
          '<SYSTEM_MESSAGE>',
          'Keep inline <SYSTEM_MESSAGE> and </SYSTEM_MESSAGE> mentions intact.',
          '</SYSTEM_MESSAGE>',
        ].join('\n'),
      },
      {
        step_index: 3,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T05:10:03Z',
        content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\nUnclosed truncated notice',
      },
      {
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T05:10:04Z',
        content: '<USER_REQUEST>\nReal first prompt\n</USER_REQUEST>',
      },
    ]);

    const parsed = parseAntigravityTranscript(transcriptPath, sessionId);
    assert.ok(parsed);
    assert.equal(parsed.userMessageCount, 1);
    assert.equal(parsed.firstUserMessage, 'Real first prompt');
    assert.deepEqual(
      parsed.messages.slice(0, 4).map(m => JSON.parse(m.content)),
      [
        [{ type: 'text', text: 'First notification body\n\nSecond notification body' }],
        [{ type: 'text', text: 'Bare notification without preamble' }],
        [{ type: 'text', text: 'Keep inline <SYSTEM_MESSAGE> and </SYSTEM_MESSAGE> mentions intact.' }],
        [{ type: 'text', text: 'Unclosed truncated notice' }],
      ],
    );

    assert.equal(
      extractAntigravitySystemText('The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n\n</SYSTEM_MESSAGE>'),
      '',
    );
    assert.equal(extractAntigravitySystemText('<SYSTEM_MESSAGE>Inline alert</SYSTEM_MESSAGE>'), 'Inline alert');
    assert.equal(extractAntigravitySystemText('Plain un-tagged system note'), 'Plain un-tagged system note');

    const adversarialSystem = '<SYSTEM_MESSAGE>\n'.repeat(5000) + 'payload</SYSTEM_MESSAGE>';
    const started = performance.now();
    const extracted = extractAntigravitySystemText(adversarialSystem);
    assert.ok(performance.now() - started < 100);
    assert.ok(extracted.includes('payload'));
  });

  test('falls back cleanly to SQLite steps summary when transcript.jsonl is absent, empty, or unparseable', () => {
    const home = path.join(tempDir, 'agr-fallback');
    const absentId = '55555555-aaaa-bbbb-cccc-666666666666';
    const emptyId = '77777777-aaaa-bbbb-cccc-888888888888';
    const corruptId = '99999999-aaaa-bbbb-cccc-000000000000';

    const absentDb = path.join(home, 'conversations', `${absentId}.db`);
    const emptyDb = path.join(home, 'conversations', `${emptyId}.db`);
    const corruptDb = path.join(home, 'conversations', `${corruptId}.db`);

    writeConversationDb(absentDb);
    writeConversationDb(emptyDb);
    writeConversationDb(corruptDb);
    writeTranscript(home, emptyId, ['   ', '']);
    writeTranscript(home, corruptId, ['{not valid json', 'also broken']);

    for (const [id, dbPath] of [[absentId, absentDb], [emptyId, emptyDb], [corruptId, corruptDb]] as const) {
      const parsed = parseAntigravitySessions(dbPath);
      assert.equal(parsed.metadata.fidelity, 'summary', id);
      assert.ok(parsed.messages.length > 0);
      syncAntigravityLiveSession(getDb(), parsed);
      const live = getLiveSession(id);
      assert.equal(live?.fidelity, 'summary', id);
      assert.equal(live?.integration_mode, 'antigravity-sqlite', id);
    }
  });

  test('hashAntigravityDb detects transcript creation/update and sync enables FTS search & v2 API', async () => {
    const home = path.join(tempDir, 'agr-sync-fts');
    const sessionId = 'abababab-1111-2222-3333-cdcdcdcdcdcd';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbPath, {
      steps: [{ idx: 0, type: 14, oneof: 19, tsSecs: 1795651200 }],
      generations: [{ model: 'gemini-4-neon', sys: 200, inp: 800, cached: 4000 }],
    });
    writeSummaryDb(home, [{
      conversation_id: sessionId,
      title: '',
      preview: '',
      workspace_uris: JSON.stringify(['file:///Users/example/Dev/agentmonitor']),
    }]);

    const db = getDb();
    const initial = syncAllAntigravityFiles(db, home, {});
    assert.equal(initial.parsed, 1);
    assert.equal(getLiveSession(sessionId)?.fidelity, 'summary');
    assert.equal(getLiveSession(sessionId)?.integration_mode, 'antigravity-sqlite');

    const hashBefore = hashAntigravityDb(dbPath);
    assert.equal(syncAllAntigravityFiles(db, home, {}).parsed, 0);

    const transcriptPath = writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>\nInvestigate xylophone telemetry drift\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:02Z',
        thinking: 'Checking marimba cache alignment.',
        content: 'Found the vibraphone offset bug.',
        tool_calls: [{ name: 'edit_file', args: { Path: '"/Users/example/Dev/agentmonitor/src/kalimba.ts"' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T10:00:03Z',
        content: 'Updated glockenspiel configuration.',
      },
    ]);

    const hashWithTranscript = hashAntigravityDb(dbPath);
    assert.notEqual(hashWithTranscript, hashBefore, 'adding transcript.jsonl flips hash');

    const resync = syncAntigravitySessionFileDetailed(db, dbPath);
    assert.equal(resync.result, 'parsed');
    assert.equal(resync.fidelity, 'full');
    assert.equal(resync.integration_mode, 'antigravity-transcript');

    const sessionRow = getLiveSession(sessionId);
    assert.ok(sessionRow);
    assert.equal(sessionRow.fidelity, 'full');
    assert.equal(sessionRow.integration_mode, 'antigravity-transcript');
    assert.deepEqual(sessionRow.capabilities, {
      history: 'full',
      search: 'full',
      tool_analytics: 'full',
      live_items: 'full',
    });
    assert.equal(sessionRow.first_message, 'Investigate xylophone telemetry drift');

    for (const term of ['xylophone', 'marimba', 'vibraphone', 'kalimba', 'glockenspiel', 'edit_file']) {
      const hits = searchMessages({ q: term, agent: 'antigravity' });
      assert.ok(hits.total >= 1, `FTS finds ${term}`);
      assert.equal(hits.data[0].session_id, sessionId);
    }
    assert.equal(searchMessages({ q: 'tool_use_id', agent: 'antigravity' }).total, 0);

    const apiSession = await fetch(`${baseUrl}/api/v2/sessions/${sessionId}`).then(r => r.json()) as Record<string, unknown>;
    assert.equal(apiSession.fidelity, 'full');
    assert.equal(apiSession.integration_mode, 'antigravity-transcript');

    const apiSearch = await fetch(`${baseUrl}/api/v2/search?agent=antigravity&q=vibraphone`).then(r => r.json()) as {
      total: number;
      data: Array<{ session_id: string; snippet: string }>;
    };
    assert.equal(apiSearch.total, 1);
    assert.equal(apiSearch.data[0].session_id, sessionId);
    assert.match(apiSearch.data[0].snippet, /vibraphone/);

    const toolsRes = await fetch(`${baseUrl}/api/v2/analytics/tools?agent=antigravity`).then(r => r.json()) as {
      data: Array<{ tool_name: string; category: string; count: number }>;
    };
    assert.ok(toolsRes.data.some(row => row.tool_name === 'edit_file' && row.category === 'Edit' && row.count >= 1));

    const daily = getDailyConversationActivity('2026-11-26', '2026-11-26');
    assert.ok(daily.data.some(d => d.agent === 'antigravity' && d.classification === 'conversation' && d.count >= 1));

    fs.appendFileSync(transcriptPath, JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-26T10:00:05Z',
      content: 'Follow-up percussion note.',
    }) + '\n');
    const hashAfterAppend = hashAntigravityDb(dbPath);
    assert.notEqual(hashAfterAppend, hashWithTranscript, 'appending transcript.jsonl flips hash');
    const appendOutcome = syncAntigravitySessionFileDetailed(db, dbPath);
    assert.equal(appendOutcome.result, 'parsed');
    assert.equal(appendOutcome.live?.reset, false, 'appended message preserves existing live turns');
    assert.equal(searchMessages({ q: 'percussion', agent: 'antigravity' }).total, 1);
  });

  test('marks truncated_fields visibly at summary fidelity and upgrades when transcript_full.jsonl appears', () => {
    const home = path.join(tempDir, 'agr-truncated-fidelity');
    const sessionId = 'cececece-1111-2222-3333-dfdfdfdfdfdf';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbPath, {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: 1795651200 },
        { idx: 1, type: 15, oneof: 20, tsSecs: 1795651205 },
        { idx: 2, type: 15, oneof: 20, tsSecs: 1795651210 },
      ],
    });
    writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T11:00:00Z',
        content: '<USER_REQUEST>\nInspect bounded mirror handling\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T11:00:05Z',
        thinking: 'Shortened thought',
        content: 'Calling view_file',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/Users/example/big.ts"' } }],
        truncated_fields: ['thinking'],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'VIEW_FILE',
        status: 'DONE',
        created_at: '2026-11-26T11:00:10Z',
        content: 'First 50 bytes...',
        truncated_fields: ['content'],
      },
    ], 'transcript.jsonl');

    const db = getDb();
    const compactHash = hashAntigravityDb(dbPath);
    const firstSync = syncAntigravitySessionFileDetailed(db, dbPath);
    assert.equal(firstSync.result, 'parsed');
    assert.equal(firstSync.fidelity, 'summary');
    assert.equal(firstSync.integration_mode, 'antigravity-transcript');

    const compactSession = getLiveSession(sessionId);
    assert.equal(compactSession?.fidelity, 'summary');
    assert.equal(compactSession?.integration_mode, 'antigravity-transcript');
    assert.deepEqual(compactSession?.capabilities, {
      history: 'summary',
      search: 'summary',
      tool_analytics: 'summary',
      live_items: 'summary',
    });
    const compactTrace = db.prepare(
      "SELECT json_extract(coverage_json, '$.has_full_transcript') AS has_full FROM session_trace_summary WHERE session_id = ?",
    ).get(sessionId) as { has_full: number } | undefined;
    assert.equal(compactTrace?.has_full, 0, 'bounded transcript does not claim has_full_transcript=true');

    const parsedCompact = parseAntigravitySessions(dbPath);
    assert.equal(parsedCompact.metadata.fidelity, 'summary');
    const plannerBlocks = JSON.parse(parsedCompact.messages[1].content) as Array<Record<string, unknown>>;
    assert.match(String(plannerBlocks[0].thinking), /\[truncated: thinking\]/);
    const viewBlocks = JSON.parse(parsedCompact.messages[2].content) as Array<Record<string, unknown>>;
    assert.match(String(viewBlocks[0].content), /\[truncated: content\]/);

    const fullPath = writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T11:00:00Z',
        content: '<USER_REQUEST>\nInspect bounded mirror handling\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T11:00:05Z',
        thinking: 'Complete full thought text',
        content: 'Calling view_file',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/Users/example/big.ts"' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'VIEW_FILE',
        status: 'DONE',
        created_at: '2026-11-26T11:00:10Z',
        content: 'Complete full file contents verbatim',
      },
    ], 'transcript_full.jsonl');
    assert.ok(fullPath.endsWith('transcript_full.jsonl'));

    assert.notEqual(hashAntigravityDb(dbPath), compactHash, 'adding transcript_full.jsonl flips hash');
    const upgradeSync = syncAntigravitySessionFileDetailed(db, dbPath);
    assert.equal(upgradeSync.result, 'parsed');
    assert.equal(upgradeSync.fidelity, 'full');
    assert.equal(upgradeSync.integration_mode, 'antigravity-transcript');
    assert.equal(getLiveSession(sessionId)?.fidelity, 'full');
    const fullTrace = db.prepare(
      "SELECT json_extract(coverage_json, '$.has_full_transcript') AS has_full FROM session_trace_summary WHERE session_id = ?",
    ).get(sessionId) as { has_full: number } | undefined;
    assert.equal(fullTrace?.has_full, 1, 'untruncated transcript_full.jsonl reports has_full_transcript=true');
    assert.equal(searchMessages({ q: 'truncated', agent: 'antigravity' }).data.some(h => h.session_id === sessionId), false);
    assert.equal(searchMessages({ q: 'verbatim', agent: 'antigravity' }).data.some(h => h.session_id === sessionId), true);
  });

  test('deduplicates replayed step_index entries and maintains transitive sorting with non-colliding line call IDs', () => {
    const home = path.join(tempDir, 'agr-dedupe-sort');
    const sessionId = 'dededed0-1111-2222-3333-fefefefefe00';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbPath);
    const transcriptPath = writeTranscript(home, sessionId, [
      {
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T12:00:05Z',
        content: 'Unindexed trailing call',
        tool_calls: [{ name: 'finish', args: { ok: 'true' } }],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        created_at: '2026-11-26T12:00:02Z',
        content: 'Draft response',
        tool_calls: [{ name: 'grep_search', args: { Query: '"draft"' } }],
      },
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T12:00:00Z',
        content: '<USER_REQUEST>\nSearch deduplication\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T12:00:03Z',
        content: 'Final response',
        tool_calls: [{ name: 'grep_search', args: { Query: '"final"' } }],
      },
    ]);

    const parsed = parseAntigravityTranscript(transcriptPath, sessionId);
    assert.ok(parsed);
    assert.equal(parsed.messages.length, 3, 'replayed step_index 1 deduplicated to latest occurrence');
    assert.equal(parsed.toolCalls.length, 2, 'replayed tool call not double-counted');
    assert.equal(JSON.parse(parsed.messages[1].content)[0].text, 'Final response');
    assert.equal(parsed.toolCalls[0].tool_use_id, 'antigravity:1:0');
    assert.equal(JSON.parse(parsed.toolCalls[0].input_json!).Query, 'final');
    assert.equal(parsed.toolCalls[1].tool_use_id, 'antigravity:line:0:0');
    assert.notEqual(parsed.toolCalls[0].tool_use_id, parsed.toolCalls[1].tool_use_id);
  });

  test('pairs unknown typed results by name/call_id and leaves ambiguous multi-call GENERIC results unpaired', () => {
    const home = path.join(tempDir, 'agr-pairing');
    const sessionId = '12121212-aaaa-bbbb-cccc-343434343434';
    const transcriptPath = writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T13:00:00Z',
        content: 'Running command then searching.',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"ls"' } },
          { name: 'grep_search', args: { Query: '"foo"' } },
        ],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'RUN_COMMAND',
        status: 'DONE',
        created_at: '2026-11-26T13:00:01Z',
        content: 'fileA.ts',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T13:00:02Z',
        content: 'src/foo.ts:1:foo',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T13:00:03Z',
        content: 'Two parallel calls with generic outputs.',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"pwd"' } },
          { name: 'read_file', args: { Path: '"/Users/example/a.ts"' } },
        ],
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T13:00:04Z',
        content: 'Output 1',
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T13:00:05Z',
        content: 'Output 2',
      },
      {
        step_index: 6,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T13:00:06Z',
        content: 'Two parallel calls correlated by native call_id out of order.',
        tool_calls: [
          { call_id: 'cid-first', name: 'read_file', args: { Path: '"/Users/example/first.ts"' } },
          { call_id: 'cid-second', name: 'read_file', args: { Path: '"/Users/example/second.ts"' } },
        ],
      },
      {
        step_index: 7,
        source: 'MODEL',
        type: 'GENERIC',
        call_id: 'cid-second',
        status: 'DONE',
        created_at: '2026-11-26T13:00:07Z',
        content: 'Second file output',
      },
      {
        step_index: 8,
        source: 'MODEL',
        type: 'GENERIC',
        call_id: 'cid-first',
        status: 'DONE',
        created_at: '2026-11-26T13:00:08Z',
        content: 'First file output',
      },
    ]);

    const parsed = parseAntigravityTranscript(transcriptPath, sessionId);
    assert.ok(parsed);
    assert.equal(parsed.messages.length, 9);

    const runCmdResult = JSON.parse(parsed.messages[1].content)[0] as Record<string, unknown>;
    assert.equal(runCmdResult.content, 'fileA.ts');
    assert.equal(runCmdResult.tool_use_id, parsed.toolCalls[0].tool_use_id, 'RUN_COMMAND pairs to run_command');

    const grepResult = JSON.parse(parsed.messages[2].content)[0] as Record<string, unknown>;
    assert.equal(grepResult.content, 'src/foo.ts:1:foo');
    assert.equal(grepResult.tool_use_id, parsed.toolCalls[1].tool_use_id, 'remaining GENERIC pairs cleanly to sole remaining grep_search');

    const ambig1 = JSON.parse(parsed.messages[4].content)[0] as Record<string, unknown>;
    const ambig2 = JSON.parse(parsed.messages[5].content)[0] as Record<string, unknown>;
    assert.equal(ambig1.tool_use_id, undefined, 'ambiguous multi-call GENERIC 1 remains explicitly unpaired');
    assert.equal(ambig2.tool_use_id, undefined, 'ambiguous multi-call GENERIC 2 remains explicitly unpaired');

    const outOfOrderSecond = JSON.parse(parsed.messages[7].content)[0] as Record<string, unknown>;
    const outOfOrderFirst = JSON.parse(parsed.messages[8].content)[0] as Record<string, unknown>;
    assert.equal(outOfOrderSecond.tool_use_id, 'cid-second');
    assert.equal(outOfOrderFirst.tool_use_id, 'cid-first');
  });

  test('preserves trailing SQLite steps and later ended_at when transcript lags SQLite', () => {
    const home = path.join(tempDir, 'agr-lagging');
    const sessionId = '56565656-aaaa-bbbb-cccc-787878787878';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbPath, {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: 1795694400 },
        { idx: 1, type: 15, oneof: 20, tsSecs: 1795694405 },
        { idx: 2, type: 15, oneof: 20, tsSecs: 1795694430 },
      ],
    });
    const transcriptPath = writeTranscript(home, sessionId, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T12:00:00Z',
        content: '<USER_REQUEST>\nPrompt before lag\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T12:00:05Z',
        content: 'First reply flushed.',
      },
    ]);

    const lagging = parseAntigravitySessions(dbPath);
    assert.equal(lagging.metadata.ended_at, '2026-11-26T12:00:30.000Z', 'preserves later SQLite ended_at');
    assert.equal(lagging.messages.length, 3, 'appends trailing unflushed SQLite step placeholder');

    fs.appendFileSync(transcriptPath, JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-26T12:00:30Z',
      content: 'Final reply caught up.',
    }) + '\n');
    const caughtUp = parseAntigravitySessions(dbPath);
    assert.equal(caughtUp.messages.length, 3);
    assert.equal(JSON.parse(caughtUp.messages[2].content)[0].text, 'Final reply caught up.');
  });
});
