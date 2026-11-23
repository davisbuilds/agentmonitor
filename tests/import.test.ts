import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseClaudeCodeFile, discoverClaudeCodeLogs } from '../src/import/claude-code.js';
import { parseCodexFile, discoverCodexLogs } from '../src/import/codex.js';

describe('Claude Code log parser', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cc-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, lines: unknown[]): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'));
    return filePath;
  }

  test('parses tool_use lines with tool name and model', () => {
    const filePath = writeJsonl('sess-1.jsonl', [
      {
        type: 'tool_use',
        sessionId: 'sess-1',
        name: 'Bash',
        model: 'claude-sonnet-4-5-20250929',
        timestamp: '2026-02-01T10:00:00Z',
        usage: { input_tokens: 1500, output_tokens: 300 },
      },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'tool_use');
    assert.equal(events[0].tool_name, 'Bash');
    assert.equal(events[0].model, 'claude-sonnet-4-5-20250929');
    assert.equal(events[0].tokens_in, 1500);
    assert.equal(events[0].tokens_out, 300);
    assert.equal(events[0].source, 'import');
    assert.equal(events[0].session_id, 'sess-1');
  });

  test('parses tool_result lines as tool_use events', () => {
    const filePath = writeJsonl('sess-2.jsonl', [
      {
        type: 'tool_result',
        sessionId: 'sess-2',
        name: 'Read',
        timestamp: '2026-02-01T10:01:00Z',
      },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'tool_use');
    assert.equal(events[0].tool_name, 'Read');
  });

  test('parses assistant lines as response events', () => {
    const filePath = writeJsonl('sess-3.jsonl', [
      {
        type: 'assistant',
        sessionId: 'sess-3',
        model: 'claude-sonnet-4-5-20250929',
        timestamp: '2026-02-01T10:02:00Z',
        usage: { input_tokens: 5000, output_tokens: 1000 },
        costUSD: 0.03,
      },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'llm_response');
    assert.equal(events[0].tokens_in, 5000);
    assert.equal(events[0].tokens_out, 1000);
    assert.ok(events[0].cost_usd !== undefined);
    assert.ok((events[0].cost_usd as number) > 0);
  });

  test('computes delta cost from cumulative costUSD', () => {
    const filePath = writeJsonl('sess-cost.jsonl', [
      { type: 'assistant', sessionId: 's', costUSD: 0.05, timestamp: '2026-02-01T10:00:00Z' },
      { type: 'assistant', sessionId: 's', costUSD: 0.12, timestamp: '2026-02-01T10:01:00Z' },
      { type: 'assistant', sessionId: 's', costUSD: 0.20, timestamp: '2026-02-01T10:02:00Z' },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 3);
    assert.ok(Math.abs((events[0].cost_usd as number) - 0.05) < 0.001);
    assert.ok(Math.abs((events[1].cost_usd as number) - 0.07) < 0.001);
    assert.ok(Math.abs((events[2].cost_usd as number) - 0.08) < 0.001);
  });

  test('extracts cache tokens from usage block', () => {
    const filePath = writeJsonl('sess-cache.jsonl', [
      {
        type: 'assistant',
        sessionId: 'sess-cache',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 800,
        },
        timestamp: '2026-02-01T10:00:00Z',
      },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].cache_read_tokens, 5000);
    assert.equal(events[0].cache_write_tokens, 800);
  });

  test('bills one assistant turn once when it spans several content blocks', () => {
    // WHY: The producer repeats cumulative usage across content blocks. Billing each block would
    // count one turn more than once.
    const usage = {
      input_tokens: 2,
      output_tokens: 254,
      cache_read_input_tokens: 21503,
      cache_creation_input_tokens: 23573,
    };
    const line = (content: unknown) => ({
      type: 'assistant',
      sessionId: 'sess-blocks',
      timestamp: '2026-02-01T10:00:00Z',
      message: { id: 'msg_01SplitAcrossBlocks', model: 'claude-sonnet-4-5-20250929', usage, content },
    });
    const filePath = writeJsonl('sess-blocks.jsonl', [
      line([{ type: 'thinking', thinking: 'deciding' }]),
      line([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
      line([{ type: 'text', text: 'done' }]),
    ]);

    const events = parseClaudeCodeFile(filePath);

    assert.equal(events.length, 3);

    const sum = (field: 'tokens_in' | 'tokens_out' | 'cache_read_tokens' | 'cache_write_tokens') =>
      events.reduce((total, event) => total + (event[field] ?? 0), 0);
    assert.equal(sum('tokens_in'), usage.input_tokens);
    assert.equal(sum('tokens_out'), usage.output_tokens);
    assert.equal(sum('cache_read_tokens'), usage.cache_read_input_tokens);
    assert.equal(sum('cache_write_tokens'), usage.cache_creation_input_tokens);

    const second = writeJsonl('sess-blocks-2.jsonl', [
      line([{ type: 'text', text: 'first' }]),
      { ...line([{ type: 'text', text: 'second' }]), message: { id: 'msg_02Second', usage } },
    ]);
    const twoTurns = parseClaudeCodeFile(second);
    assert.equal(
      twoTurns.reduce((total, event) => total + (event.tokens_out ?? 0), 0),
      usage.output_tokens * 2,
    );
  });

  test('bills a turn with the usage its last line records', () => {
    // WHY: Output grows across blocks of one turn, so its final sample carries usage earlier samples
    // cannot represent.
    const line = (output: number, content: unknown) => ({
      type: 'assistant',
      sessionId: 'sess-growing',
      timestamp: '2026-02-01T10:00:00Z',
      message: {
        id: 'msg_01Growing',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 },
        content,
      },
    });
    const filePath = writeJsonl('sess-growing.jsonl', [
      line(3, [{ type: 'thinking', thinking: 'deciding' }]),
      line(120, [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
      line(254, [{ type: 'text', text: 'done' }]),
    ]);

    const events = parseClaudeCodeFile(filePath);

    assert.deepEqual(events.map(event => event.tokens_out), [254, 0, 0]);
    assert.deepEqual(events.map(event => event.cache_read_tokens), [500, 0, 0]);
  });

  test('a date-scoped parse that starts mid-turn does not bill the turn\'s later lines', () => {
    // WHY: Starting a visible slice later does not change where a cumulative turn was originally
    // billed.
    const line = (timestamp: string, content: unknown) => ({
      type: 'assistant',
      sessionId: 'sess-scoped',
      timestamp,
      message: { id: 'msg_01Scoped', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 2, output_tokens: 254 }, content },
    });
    const filePath = writeJsonl('sess-scoped.jsonl', [
      line('2026-02-01T09:59:59Z', [{ type: 'thinking', thinking: 'deciding' }]),
      line('2026-02-01T10:00:01Z', [{ type: 'text', text: 'done' }]),
    ]);

    const events = parseClaudeCodeFile(filePath, { from: new Date('2026-02-01T10:00:00Z') });

    assert.deepEqual(events.map(event => event.tokens_out), [0]);
  });

  test('does not collide with a child-agent transcript at the same line index', () => {
    // WHY: Legacy keys used the reported session and line index. Children that report their parent’s
    // session collide on that scheme.
    const sessionId = 'parent-session-uuid';
    const parent = writeJsonl(`${sessionId}.jsonl`, [
      { type: 'assistant', sessionId, uuid: 'uuid-parent-0', timestamp: '2026-02-01T10:00:00Z', message: { id: 'msg_p', usage: { input_tokens: 5, output_tokens: 7 } } },
      { type: 'assistant', sessionId, uuid: 'uuid-parent-1', timestamp: '2026-02-01T10:01:00Z', message: { id: 'msg_p2', usage: { input_tokens: 3, output_tokens: 4 } } },
    ]);
    const child = writeJsonl('agent-child123.jsonl', [
      { type: 'assistant', sessionId, isSidechain: true, agentId: 'child123', uuid: 'uuid-child-0', timestamp: '2026-02-01T10:02:00Z', message: { id: 'msg_c', usage: { input_tokens: 9, output_tokens: 11 } } },
    ]);

    const parentIds = new Set(parseClaudeCodeFile(parent).map(e => e.event_id));
    const childIds = parseClaudeCodeFile(child).map(e => e.event_id);

    assert.equal(childIds.filter(id => parentIds.has(id)).length, 0);
    assert.deepEqual(parseClaudeCodeFile(child).map(e => e.event_id), childIds);
  });

  test('keeps uuid-less child-agent lines distinct from the parent', () => {
    // WHY: Lines without UUIDs still need a fallback that distinguishes child files reporting the
    // parent’s ID.
    const sessionId = 'fallback-session-uuid';
    const parent = writeJsonl(`${sessionId}.jsonl`, [
      { type: 'assistant', sessionId, timestamp: '2026-02-01T10:00:00Z', message: { id: 'mp', usage: { input_tokens: 1, output_tokens: 2 } } },
    ]);
    const child = writeJsonl('agent-nouuid.jsonl', [
      { type: 'assistant', sessionId, isSidechain: true, agentId: 'nouuid', timestamp: '2026-02-01T10:01:00Z', message: { id: 'mc', usage: { input_tokens: 3, output_tokens: 4 } } },
    ]);

    const [parentEvent] = parseClaudeCodeFile(parent);
    const [childEvent] = parseClaudeCodeFile(child);

    assert.notEqual(childEvent.event_id, parentEvent.event_id);
    // WHY: Keep the parent fallback identical so old imported keys still participate in
    // reconciliation.
    assert.equal(parentEvent.event_id, parentEvent.legacy_event_id);
  });

  test('records the originating agent on child-agent events', () => {
    const sessionId = 'attr-session-uuid';
    const child = writeJsonl('agent-attr456.jsonl', [
      { type: 'assistant', sessionId, isSidechain: true, agentId: 'attr456', uuid: 'uuid-attr-0', timestamp: '2026-02-01T10:00:00Z', message: { id: 'msg_a', usage: { input_tokens: 1, output_tokens: 2 } } },
    ]);

    const [event] = parseClaudeCodeFile(child);
    assert.equal(event.session_id, sessionId);
    const metadata = event.metadata as Record<string, unknown>;
    assert.equal(metadata.agent_id, 'attr456');
    assert.equal(metadata.agent_transcript, 'agent-attr456');
  });

  test('generates deterministic event_id for dedup', () => {
    const filePath = writeJsonl('sess-dedup.jsonl', [
      { type: 'tool_use', sessionId: 'sess-dedup', name: 'Bash', timestamp: '2026-02-01T10:00:00Z' },
    ]);

    const events1 = parseClaudeCodeFile(filePath);
    const events2 = parseClaudeCodeFile(filePath);
    assert.equal(events1[0].event_id, events2[0].event_id);
    assert.ok(events1[0].event_id?.startsWith('import-cc-'));
  });

  test('uses filename as session_id fallback', () => {
    const filePath = writeJsonl('my-session-uuid.jsonl', [
      { type: 'assistant', timestamp: '2026-02-01T10:00:00Z' },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events[0].session_id, 'my-session-uuid');
  });

  test('marks error lines with error status', () => {
    const filePath = writeJsonl('sess-err.jsonl', [
      { type: 'error', sessionId: 'sess-err', error: 'something broke', timestamp: '2026-02-01T10:00:00Z' },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events[0].event_type, 'error');
    assert.equal(events[0].status, 'error');
  });

  test('applies date filter (--from)', () => {
    const filePath = writeJsonl('sess-filter.jsonl', [
      { type: 'assistant', sessionId: 's', timestamp: '2026-01-01T10:00:00Z' },
      { type: 'assistant', sessionId: 's', timestamp: '2026-02-01T10:00:00Z' },
    ]);

    const events = parseClaudeCodeFile(filePath, { from: new Date('2026-01-15T00:00:00Z') });
    assert.equal(events.length, 1);
    assert.equal(events[0].client_timestamp, '2026-02-01T10:00:00Z');
  });

  test('applies date filter (--to)', () => {
    const filePath = writeJsonl('sess-filter2.jsonl', [
      { type: 'assistant', sessionId: 's', timestamp: '2026-01-01T10:00:00Z' },
      { type: 'assistant', sessionId: 's', timestamp: '2026-03-01T10:00:00Z' },
    ]);

    const events = parseClaudeCodeFile(filePath, { to: new Date('2026-02-01T00:00:00Z') });
    assert.equal(events.length, 1);
    assert.equal(events[0].client_timestamp, '2026-01-01T10:00:00Z');
  });

  test('skips malformed JSON lines gracefully', () => {
    const filePath = path.join(tmpDir, 'sess-bad.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-02-01T10:00:00Z' }),
      'this is not json {{{',
      JSON.stringify({ type: 'tool_use', sessionId: 's', name: 'Bash', timestamp: '2026-02-01T10:01:00Z' }),
    ].join('\n'));

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 2);
  });

  test('skips lines without type field', () => {
    const filePath = writeJsonl('sess-notype.jsonl', [
      { sessionId: 's', model: 'claude-sonnet-4-5-20250929' },
      { type: 'assistant', sessionId: 's', timestamp: '2026-02-01T10:00:00Z' },
    ]);

    const events = parseClaudeCodeFile(filePath);
    assert.equal(events.length, 1);
  });
});

describe('Claude Code log discovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-disc-test-'));
    fs.mkdirSync(path.join(tmpDir, 'projects', 'project-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'project-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'project-b', 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'sess-1.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'sess-2.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-b', 'sess-3.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-b', 'nested', 'deeper', 'sess-4.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'other.txt'), '');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('discovers all .jsonl files across project directories', () => {
    const files = discoverClaudeCodeLogs(tmpDir);
    assert.equal(files.length, 4);
    assert.ok(files.every(f => f.endsWith('.jsonl')));
  });

  test('discovers nested .jsonl files recursively', () => {
    const files = discoverClaudeCodeLogs(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('project-b', 'nested', 'deeper', 'sess-4.jsonl'))));
  });

  test('supports exclude patterns during discovery', () => {
    fs.mkdirSync(path.join(tmpDir, 'projects', 'project-a', 'vercel-plugin'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'vercel-plugin', 'skill-injections.jsonl'), '');

    const files = discoverClaudeCodeLogs(tmpDir, { excludePatterns: ['vercel-plugin'] });
    assert.ok(!files.some(f => f.endsWith(path.join('vercel-plugin', 'skill-injections.jsonl'))));
  });

  test('ignores non-jsonl files', () => {
    const files = discoverClaudeCodeLogs(tmpDir);
    assert.ok(!files.some(f => f.endsWith('.txt')));
  });

  test('returns empty array for nonexistent directory', () => {
    const files = discoverClaudeCodeLogs('/nonexistent/path/that/does/not/exist');
    assert.deepEqual(files, []);
  });
});

describe('Codex log parser', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cdx-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, lines: unknown[]): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'));
    return filePath;
  }

  test('parses session_meta as session_start event', () => {
    const filePath = writeJsonl('codex-1.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: {
          id: 'cdx-1',
          cwd: '/home/user/project',
          originator: 'codex-cli/1.0',
          timestamp: '2026-02-01T10:00:00Z',
        },
      },
    ]);

    const events = parseCodexFile(filePath);
    assert.ok(events.length >= 1);
    assert.equal(events[0].event_type, 'session_start');
    assert.equal(events[0].session_id, 'cdx-1');
    assert.equal(events[0].agent_type, 'codex');
    assert.equal(events[0].status, 'success');
    assert.equal(events[0].source, 'import');
    const meta = events[0].metadata as Record<string, unknown>;
    assert.equal(meta.originator, 'codex-cli/1.0');
    assert.equal(meta.cwd, '/home/user/project');
  });

  test('labels the costs it prices from the tables as estimates', () => {
    const filePath = writeJsonl('codex-estimated.jsonl', [
      { type: 'session_meta', timestamp: '2026-02-01T10:00:00Z', payload: { id: 'cdx-est', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' } },
      { type: 'turn_context', timestamp: '2026-02-01T10:00:30Z', payload: { model: 'gpt-5.6-terra' } },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:01:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2500, output_tokens: 600 } } },
      },
    ]);
    const tokenEvent = parseCodexFile(filePath).find(e => e.event_type === 'llm_response');
    assert.ok(tokenEvent?.cost_usd && tokenEvent.cost_usd > 0);
    assert.equal(tokenEvent.cost_source, 'estimated');
  });

  test('parses event_msg token_count as llm_response with delta tokens', () => {
    const filePath = writeJsonl('codex-tok.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-tok', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:01:00Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 2500,
              output_tokens: 600,
              cached_input_tokens: 100,
            },
          },
        },
      },
    ]);

    const events = parseCodexFile(filePath);
    const tokenEvent = events.find(e => e.event_type === 'llm_response');
    assert.ok(tokenEvent);
    // WHY: The provider’s input count includes cached tokens, so cache reads need to be subtracted
    // before full-rate pricing.
    assert.equal(tokenEvent.tokens_in, 2400);
    assert.equal(tokenEvent.tokens_out, 600);
    assert.equal(tokenEvent.cache_read_tokens, 100);
  });

  test('computes token deltas across multiple token_count events', () => {
    const filePath = writeJsonl('codex-delta.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-delta', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:01:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } } },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:02:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3000, output_tokens: 700 } } },
      },
    ]);

    const events = parseCodexFile(filePath);
    const tokenEvents = events.filter(e => e.event_type === 'llm_response');
    assert.equal(tokenEvents.length, 2);
    assert.equal(tokenEvents[0].tokens_in, 1000);
    assert.equal(tokenEvents[0].tokens_out, 200);
    assert.equal(tokenEvents[1].tokens_in, 2000);
    assert.equal(tokenEvents[1].tokens_out, 500);
  });

  test('calculates cost for imported gpt-5.4 Codex token_count events', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), 'model = "gpt-5.4"\n');

    const filePath = writeJsonl('codex-gpt54.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-gpt54', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:01:00Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100_000,
              output_tokens: 50_000,
              cached_input_tokens: 40_000,
            },
          },
        },
      },
    ]);

    const events = parseCodexFile(filePath, { codexDir: tmpDir });
    const tokenEvent = events.find(e => e.event_type === 'llm_response');
    assert.ok(tokenEvent);
    assert.equal(tokenEvent.model, 'gpt-5.4');
    assert.equal(tokenEvent.tokens_in, 60_000);
    assert.ok(tokenEvent.cost_usd !== undefined);
    assert.ok(Math.abs((tokenEvent.cost_usd as number) - 0.91) < 0.0001);
  });

  test('calculates cost for imported gpt-5.3-codex Codex token_count events', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), 'model = "gpt-5.3-codex"\n');

    const filePath = writeJsonl('codex-gpt53-codex.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-gpt53-codex', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:01:00Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100_000,
              output_tokens: 50_000,
              cached_input_tokens: 40_000,
            },
          },
        },
      },
    ]);

    const events = parseCodexFile(filePath, { codexDir: tmpDir });
    const tokenEvent = events.find(e => e.event_type === 'llm_response');
    assert.ok(tokenEvent);
    assert.equal(tokenEvent.model, 'gpt-5.3-codex');
    assert.equal(tokenEvent.tokens_in, 60_000);
    assert.ok(tokenEvent.cost_usd !== undefined);
    assert.ok(Math.abs((tokenEvent.cost_usd as number) - 0.812) < 0.0001);
  });

  test('skipped, malformed and zero-delta lines do not shift later event ids', () => {
    // WHY: The positional counter advances only for emitted events, so ignored records must not move
    // later keys.
    const meta = {
      type: 'session_meta',
      timestamp: '2026-02-01T11:00:00Z',
      payload: { id: 'cdx-ordinal-noise', cwd: '/p', timestamp: '2026-02-01T11:00:00Z' },
    };
    const tokenCount = (minute: number, input: number, output: number) => ({
      type: 'event_msg',
      timestamp: `2026-02-01T11:0${minute}:00Z`,
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
    });

    const clean = writeJsonl('cdx-noise-clean.jsonl', [meta, tokenCount(1, 100, 10), tokenCount(2, 200, 20)]);

    const noisyPath = path.join(tmpDir, 'cdx-noise-dirty.jsonl');
    fs.writeFileSync(noisyPath, [
      JSON.stringify(meta),
      JSON.stringify(tokenCount(1, 100, 10)),
      '{ this is not json',
      '',
      JSON.stringify({ type: 'some_future_record', payload: { x: 1 } }),
      JSON.stringify(tokenCount(2, 100, 10)),
      JSON.stringify(tokenCount(3, 200, 20)),
    ].join('\n'));

    const idsOf = (file: string) => parseCodexFile(file)
      .filter(event => event.event_type === 'llm_response')
      .map(event => event.event_id);

    assert.deepEqual(idsOf(noisyPath), idsOf(clean));
  });

  test('pins the Codex event-id derivation against accidental re-keying', () => {
    // WHY: These literal IDs detect changes that would re-key existing imports and require a legacy
    // migration.
    const filePath = writeJsonl('cdx-id-pin.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T11:00:00Z',
        payload: { id: 'sess-ord', cwd: '/p', timestamp: '2026-02-01T11:00:00Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T11:01:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T11:02:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 20 } } },
      },
    ]);

    const ids = parseCodexFile(filePath)
      .filter(event => event.event_type === 'llm_response')
      .map(event => event.event_id);
    assert.deepEqual(ids, [
      'import-cdx-e1fd5253737221ab00979a1130d978b7',
      'import-cdx-2fac3397d00a64ddee4b15772656ad37',
    ]);
  });

  test('attributes each Codex token delta to the model in the active turn context', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), 'model = "gpt-5.6-sol"\n');

    const filePath = writeJsonl('codex-gpt56-switch.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-07-12T10:00:00Z',
        payload: { id: 'cdx-gpt56-switch', cwd: '/tmp', timestamp: '2026-07-12T10:00:00Z' },
      },
      { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
      {
        type: 'event_msg',
        timestamp: '2026-07-12T10:01:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100_000, output_tokens: 20_000, cached_input_tokens: 40_000 } } },
      },
      { type: 'turn_context', payload: { model: 'gpt-5.6-luna' } },
      {
        type: 'event_msg',
        timestamp: '2026-07-12T10:02:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150_000, output_tokens: 30_000, cached_input_tokens: 60_000 } } },
      },
    ]);

    const responses = parseCodexFile(filePath, { codexDir: tmpDir })
      .filter(event => event.event_type === 'llm_response');
    assert.equal(responses.length, 2);
    assert.deepEqual(responses.map(event => event.model), ['gpt-5.6-terra', 'gpt-5.6-luna']);
    assert.deepEqual(responses.map(event => (event.metadata as Record<string, unknown>)._model_source), [
      'turn_context',
      'turn_context',
    ]);
    assert.ok(Math.abs((responses[0].cost_usd as number) - 0.368) < 0.0001);
    assert.ok(Math.abs((responses[1].cost_usd as number) - 0.0184) < 0.0001);
  });

  test('parses response_item apply_patch as tool_use event', () => {
    const filePath = writeJsonl('codex-patch.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-patch', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-01T10:01:00Z',
        payload: {
          name: 'apply_patch',
          input: '*** Update File: src/main.ts\n+added line\n-removed line',
        },
      },
    ]);

    const events = parseCodexFile(filePath);
    const patchEvent = events.find(e => e.event_type === 'tool_use' && e.tool_name === 'apply_patch');
    assert.ok(patchEvent);
    assert.equal(patchEvent.status, 'success');
    const meta = patchEvent.metadata as Record<string, unknown>;
    assert.equal(meta.file_path, 'src/main.ts');
  });

  test('generates deterministic event_id for dedup', () => {
    const filePath = writeJsonl('codex-dedup.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-dedup', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
    ]);

    const events1 = parseCodexFile(filePath);
    const events2 = parseCodexFile(filePath);
    assert.equal(events1[0].event_id, events2[0].event_id);
    assert.ok(events1[0].event_id?.startsWith('import-cdx-'));
  });

  test('uses filename as session_id fallback when no session_meta', () => {
    const filePath = writeJsonl('codex-session-xyz.jsonl', [
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } } },
      },
    ]);

    const events = parseCodexFile(filePath);
    const tokenEvent = events.find(e => e.event_type === 'llm_response');
    assert.ok(tokenEvent);
    assert.equal(tokenEvent.session_id, 'codex-session-xyz');
  });

  test('adds session_end event with total token counts', () => {
    const filePath = writeJsonl('codex-end.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-end', cwd: '/tmp', timestamp: '2026-02-01T10:00:00Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-01T10:01:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } } },
      },
    ]);

    const events = parseCodexFile(filePath);
    const endEvent = events.find(e => e.event_type === 'session_end');
    assert.ok(endEvent);
    assert.equal(endEvent.session_id, 'cdx-end');
    const meta = endEvent.metadata as Record<string, unknown>;
    assert.equal(meta.total_tokens_in, 1000);
    assert.equal(meta.total_tokens_out, 200);
  });

  test('extracts project name from cwd', () => {
    const filePath = writeJsonl('codex-proj.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-02-01T10:00:00Z',
        payload: { id: 'cdx-proj', cwd: '/home/user/my-project', timestamp: '2026-02-01T10:00:00Z' },
      },
    ]);

    const events = parseCodexFile(filePath);
    assert.equal(events[0].project, 'my-project');
  });
});

describe('Codex log discovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cdx-disc-'));
    fs.mkdirSync(path.join(tmpDir, 'sessions', '2026', '01', '15'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'sessions', '2026', '02', '01'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sessions', '2026', '01', '15', 'sess-a.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'sessions', '2026', '02', '01', 'sess-b.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'sessions', '2026', '02', '01', 'sess-c.jsonl'), '');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('discovers files in nested YYYY/MM/DD structure', () => {
    const files = discoverCodexLogs(tmpDir);
    assert.equal(files.length, 3);
    assert.ok(files.every(f => f.endsWith('.jsonl')));
  });

  test('returns empty array for nonexistent directory', () => {
    const files = discoverCodexLogs('/nonexistent/path');
    assert.deepEqual(files, []);
  });
});


let server: Server;
let baseUrl = '';
let tempDbDir = '';
let getDb: (() => { exec: (sql: string) => void; prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } }) | null = null;
let closeDb: (() => void) | null = null;

before(async () => {
  tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-import-integ-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDbDir, 'agentmonitor-import-test.db');
  process.env.AGENTMONITOR_MAX_PAYLOAD_KB = '64';
  process.env.AGENTMONITOR_MAX_SSE_CLIENTS = '0';

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');

  getDb = dbModule.getDb as typeof getDb;
  closeDb = dbModule.closeDb as () => void;

  initSchema();
  server = createApp().listen(0);
  await once(server, 'listening');

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  if (!getDb) throw new Error('Database not initialized');
  getDb().exec(`
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM agents;
    DELETE FROM import_state;
  `);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) { reject(err); return; }
        resolve();
      });
    });
  }
  closeDb?.();
  if (tempDbDir) {
    fs.rmSync(tempDbDir, { recursive: true, force: true });
  }
});

describe('Import orchestrator integration', () => {
  let claudeDir: string;
  let codexDir: string;
  let antigravityDir: string;

  before(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-orch-claude-'));
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-orch-codex-'));
    // WHY: Use a separate empty discovery root so importing all providers cannot open a developer’s
    // real conversation store.
    antigravityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-orch-agr-'));

    fs.mkdirSync(path.join(claudeDir, 'projects', 'my-project'), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'projects', 'my-project', 'session-abc.jsonl'),
      [
        JSON.stringify({ type: 'tool_use', sessionId: 'session-abc', name: 'Bash', model: 'claude-sonnet-4-5-20250929', timestamp: '2026-02-01T10:00:00Z', usage: { input_tokens: 1000, output_tokens: 200 } }),
        JSON.stringify({ type: 'assistant', sessionId: 'session-abc', model: 'claude-sonnet-4-5-20250929', timestamp: '2026-02-01T10:01:00Z', costUSD: 0.01, usage: { input_tokens: 2000, output_tokens: 500 } }),
      ].join('\n'),
    );

    fs.mkdirSync(path.join(codexDir, 'sessions', '2026', '02', '01'), { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'sessions', '2026', '02', '01', 'session-xyz.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-02-01T11:00:00Z', payload: { id: 'session-xyz', cwd: '/home/user/project', timestamp: '2026-02-01T11:00:00Z' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-02-01T11:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 100 } } } }),
      ].join('\n'),
    );
  });

  after(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(antigravityDir, { recursive: true, force: true });
  });

  test('imports Claude Code logs into database', async () => {
    const { runImport } = await import('../src/import/index.js');

    const result = runImport({
      source: 'claude-code',
      claudeDir,
    });

    assert.equal(result.totalFiles, 1);
    assert.equal(result.totalEventsImported, 2);
    assert.equal(result.totalDuplicates, 0);
    assert.equal(result.skippedFiles, 0);

    const eventsRes = await fetch(`${baseUrl}/api/events?limit=10&source=import`);
    const body = await eventsRes.json() as { events: Array<Record<string, unknown>>; total: number };
    assert.equal(body.total, 2);
    assert.ok(body.events.every(e => e.source === 'import'));
    assert.ok(body.events.every(e => e.agent_type === 'claude_code'));
  });

  test('imports Codex logs into database', async () => {
    const { runImport } = await import('../src/import/index.js');

    const result = runImport({
      source: 'codex',
      codexDir,
    });

    assert.equal(result.totalFiles, 1);
    assert.equal(result.totalEventsImported, 3);

    const eventsRes = await fetch(`${baseUrl}/api/events?limit=10&source=import`);
    const body = await eventsRes.json() as { events: Array<Record<string, unknown>>; total: number };
    assert.equal(body.total, 3);
    assert.ok(body.events.every(e => e.agent_type === 'codex'));
  });

  test('import all sources together', async () => {
    const { runImport } = await import('../src/import/index.js');

    const result = runImport({
      source: 'all',
      claudeDir,
      codexDir,
      antigravityDir,
      force: true,
    });

    assert.equal(result.totalFiles, 2);
    assert.equal(result.totalEventsImported, 5);
  });

  test('skips unchanged files on re-import', async () => {
    const { runImport } = await import('../src/import/index.js');

    const result1 = runImport({ source: 'claude-code', claudeDir });
    assert.equal(result1.totalEventsImported, 2);

    const result2 = runImport({ source: 'claude-code', claudeDir });
    assert.equal(result2.skippedFiles, 1);
    assert.equal(result2.totalEventsImported, 0);
  });

  test('--force re-imports even if file unchanged', async () => {
    const { runImport } = await import('../src/import/index.js');

    runImport({ source: 'claude-code', claudeDir });

    const result2 = runImport({ source: 'claude-code', claudeDir, force: true });
    assert.equal(result2.skippedFiles, 0);
    assert.equal(result2.totalFiles, 1);
    assert.equal(result2.totalDuplicates, 2);
    assert.equal(result2.totalEventsImported, 0);
  });

  test('does not re-insert events already stored under the legacy id scheme', async () => {
    // WHY: Automatic re-import rereads changed live transcripts. Losing historical identity would
    // duplicate their events.
    const { runImport } = await import('../src/import/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-legacy-id-'));
    const sessionId = 'legacy-session-uuid';
    fs.mkdirSync(path.join(dir, 'projects', 'proj'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'proj', `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'assistant', sessionId, uuid: 'uuid-legacy-0', timestamp: '2026-02-01T10:00:00Z', message: { id: 'm0', usage: { input_tokens: 10, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', sessionId, uuid: 'uuid-legacy-1', timestamp: '2026-02-01T10:01:00Z', message: { id: 'm1', usage: { input_tokens: 30, output_tokens: 40 } } }),
    ].join('\n'));

    if (!getDb) throw new Error('Database not initialized');
    const insert = getDb().prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, source)
      VALUES (?, ?, 'claude_code', 'llm_response', 'success', 0, 0, 'import')
    `);
    for (let i = 0; i < 2; i++) {
      const legacy = `import-cc-${crypto.createHash('sha256').update(`claude-code:${sessionId}:${i}`).digest('hex').slice(0, 32)}`;
      insert.run(legacy, sessionId);
    }

    const result = runImport({ source: 'claude-code', claudeDir: dir, force: true });
    assert.equal(result.totalEventsImported, 0, 'legacy-keyed rows must still deduplicate');
    assert.equal(result.totalDuplicates, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refreshes a turn imported before its last line was written', async () => {
    // WHY: Auto-import can observe a turn before it is finished. The next read must catch its final
    // usage.
    const { runImport } = await import('../src/import/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-refresh-'));
    const sessionId = 'refresh-session-uuid';
    const file = path.join(dir, 'projects', 'proj', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const model = 'claude-sonnet-4-5-20250929';
    const line = (uuid: string, output: number) => JSON.stringify({
      type: 'assistant', sessionId, uuid, timestamp: '2026-02-01T10:00:00Z',
      message: { id: 'msg_refresh', model, usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 500 } },
    });
    fs.writeFileSync(file, [line('uuid-refresh-0', 3), line('uuid-refresh-1', 120)].join('\n'));
    runImport({ source: 'claude-code', claudeDir: dir });

    fs.appendFileSync(file, '\n' + line('uuid-refresh-2', 254));
    const result = runImport({ source: 'claude-code', claudeDir: dir });

    if (!getDb) throw new Error('Database not initialized');
    const first = getDb().prepare(`
      SELECT tokens_out, cost_usd, cost_source FROM events WHERE session_id = ? ORDER BY id LIMIT 1
    `).get(sessionId) as { tokens_out: number; cost_usd: number; cost_source: string };
    const { pricingRegistry } = await import('../src/pricing/index.js');
    assert.equal(result.totalEventsRefreshed, 1);
    assert.equal(first.tokens_out, 254);
    assert.equal(first.cost_source, 'estimated');
    assert.ok(Math.abs(first.cost_usd - (pricingRegistry.calculate(model, { input: 2, output: 254, cacheRead: 500 }, '2026-02-01T10:00:00Z') ?? NaN)) < 1e-12,
      'the estimate follows the refreshed tokens');
    const total = getDb().prepare('SELECT SUM(tokens_out) AS out FROM events WHERE session_id = ?').get(sessionId) as { out: number };
    assert.equal(total.out, 254, 'the turn is still billed once');
    // WHY: The summary has its own rollup. Replace the previous contribution so refreshing a row
    // cannot count it twice.
    const summary = getDb().prepare('SELECT tokens_out, observation_count FROM session_trace_summary WHERE session_id = ?')
      .get(sessionId) as { tokens_out: number; observation_count: number };
    const events = getDb().prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId) as { c: number };
    assert.deepEqual(summary, { tokens_out: 254, observation_count: events.c });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a refresh keeps a reported cost', async () => {
    const { runImport } = await import('../src/import/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-refresh-reported-'));
    const sessionId = 'refresh-reported-uuid';
    const file = path.join(dir, 'projects', 'proj', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (uuid: string, output: number) => JSON.stringify({
      type: 'assistant', sessionId, uuid, timestamp: '2026-02-01T10:00:00Z',
      message: { id: 'msg_refresh_reported', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 2, output_tokens: output } },
    });
    fs.writeFileSync(file, line('uuid-reported-0', 3));
    runImport({ source: 'claude-code', claudeDir: dir });
    if (!getDb) throw new Error('Database not initialized');
    getDb().prepare("UPDATE events SET cost_usd = 1.23, cost_source = 'reported' WHERE session_id = ?").run(sessionId);

    fs.appendFileSync(file, '\n' + line('uuid-reported-1', 254));
    runImport({ source: 'claude-code', claudeDir: dir });

    const first = getDb().prepare('SELECT tokens_out, cost_usd FROM events WHERE session_id = ? ORDER BY id LIMIT 1')
      .get(sessionId) as { tokens_out: number; cost_usd: number };
    assert.deepEqual(first, { tokens_out: 254, cost_usd: 1.23 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('does not refresh a row another transcript stored for the same line', async () => {
    // WHY: A resumed transcript can repeat a UUID from its predecessor. The copy must not overwrite
    // the owning transcript’s usage.
    const { runImport } = await import('../src/import/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-refresh-copy-'));
    const original = 'refresh-original-uuid';
    const resumed = 'refresh-resumed-uuid';
    fs.mkdirSync(path.join(dir, 'projects', 'proj'), { recursive: true });
    const write = (sessionId: string, output: number) => fs.writeFileSync(
      path.join(dir, 'projects', 'proj', `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant', sessionId, uuid: 'uuid-refresh-shared', timestamp: '2026-02-01T10:00:00Z',
        message: { id: 'msg_refresh_shared', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 2, output_tokens: output } },
      }),
    );
    write(original, 50);
    runImport({ source: 'claude-code', claudeDir: dir });
    write(resumed, 999);

    const result = runImport({ source: 'claude-code', claudeDir: dir });

    if (!getDb) throw new Error('Database not initialized');
    const rows = getDb().prepare("SELECT session_id, tokens_out FROM events WHERE source = 'import'").all() as Array<{ session_id: string; tokens_out: number }>;
    assert.equal(result.totalEventsRefreshed, 0);
    assert.deepEqual(rows.map(r => [r.session_id, r.tokens_out]), [[original, 50]]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('recovers child-agent events whose parent rows are stored under legacy ids', async () => {
    // WHY: A child can share legacy IDs with its parent. Treating those parent rows as child
    // duplicates would suppress real child usage.
    const { runImport } = await import('../src/import/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-child-recovery-'));
    const sessionId = 'recovery-parent-uuid';
    const projDir = path.join(dir, 'projects', 'proj');
    fs.mkdirSync(path.join(projDir, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'assistant', sessionId, uuid: 'uuid-rp-0', timestamp: '2026-02-01T10:00:00Z', message: { id: 'mrp0', usage: { input_tokens: 10, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', sessionId, uuid: 'uuid-rp-1', timestamp: '2026-02-01T10:01:00Z', message: { id: 'mrp1', usage: { input_tokens: 10, output_tokens: 20 } } }),
    ].join('\n'));
    fs.writeFileSync(path.join(projDir, sessionId, 'subagents', 'agent-recovered.jsonl'), [
      JSON.stringify({ type: 'assistant', sessionId, isSidechain: true, agentId: 'recovered', uuid: 'uuid-rk-0', timestamp: '2026-02-01T10:02:00Z', message: { id: 'mrk0', usage: { input_tokens: 7, output_tokens: 8 } } }),
      JSON.stringify({ type: 'assistant', sessionId, isSidechain: true, agentId: 'recovered', uuid: 'uuid-rk-1', timestamp: '2026-02-01T10:03:00Z', message: { id: 'mrk1', usage: { input_tokens: 7, output_tokens: 8 } } }),
    ].join('\n'));

    if (!getDb) throw new Error('Database not initialized');
    const insert = getDb().prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, source)
      VALUES (?, ?, 'claude_code', 'llm_response', 'success', 0, 0, 'import')
    `);
    for (let i = 0; i < 2; i++) {
      const legacy = `import-cc-${crypto.createHash('sha256').update(`claude-code:${sessionId}:${i}`).digest('hex').slice(0, 32)}`;
      insert.run(legacy, sessionId);
    }

    const result = runImport({ source: 'claude-code', claudeDir: dir, force: true });
    assert.equal(result.totalEventsImported, 2, 'the two child events are recovered');
    assert.equal(result.totalDuplicates, 2, 'the parent stays bridged to its legacy rows');

    const agentRows = getDb()
      .prepare("SELECT COUNT(*) AS c FROM events WHERE json_extract(metadata, '$.agent_id') = 'recovered'")
      .get() as { c: number };
    assert.equal(agentRows.c, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('imports child-agent events even though the parent owns the legacy ids', async () => {
    const { runImport } = await import('../src/import/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-child-import-'));
    const sessionId = 'child-parent-uuid';
    const projDir = path.join(dir, 'projects', 'proj');
    fs.mkdirSync(path.join(projDir, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'assistant', sessionId, uuid: 'uuid-pp-0', timestamp: '2026-02-01T10:00:00Z', message: { id: 'mp0', usage: { input_tokens: 10, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', sessionId, uuid: 'uuid-pp-1', timestamp: '2026-02-01T10:01:00Z', message: { id: 'mp1', usage: { input_tokens: 10, output_tokens: 20 } } }),
    ].join('\n'));
    fs.writeFileSync(path.join(projDir, sessionId, 'subagents', 'agent-kid.jsonl'), [
      JSON.stringify({ type: 'assistant', sessionId, isSidechain: true, agentId: 'kid', uuid: 'uuid-kid-0', timestamp: '2026-02-01T10:02:00Z', message: { id: 'mk0', usage: { input_tokens: 7, output_tokens: 8 } } }),
      JSON.stringify({ type: 'assistant', sessionId, isSidechain: true, agentId: 'kid', uuid: 'uuid-kid-1', timestamp: '2026-02-01T10:03:00Z', message: { id: 'mk1', usage: { input_tokens: 7, output_tokens: 8 } } }),
    ].join('\n'));

    const first = runImport({ source: 'claude-code', claudeDir: dir });
    assert.equal(first.totalEventsImported, 4, 'both transcripts contribute their own events');

    // WHY: A child sharing the reported session ID must not take away the parent’s legacy bridge or
    // the next import would duplicate its history.
    const second = runImport({ source: 'claude-code', claudeDir: dir, force: true });
    assert.equal(second.totalEventsImported, 0);
    assert.equal(second.totalDuplicates, 4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('forced Codex re-import corrects explicit per-turn model attribution and refreshes its summary', async () => {
    const isolatedCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-model-refresh-'));
    const sessionsDir = path.join(isolatedCodexDir, 'sessions', '2026', '07', '12');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(isolatedCodexDir, 'config.toml'), 'model = "gpt-5.6-sol"\n');
    const filePath = path.join(sessionsDir, 'model-refresh.jsonl');
    const sessionMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-12T11:00:00Z',
      payload: { id: 'session-model-refresh', cwd: '/tmp', timestamp: '2026-07-12T11:00:00Z' },
    });
    const tokenCount = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-12T11:01:00Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 100_000, output_tokens: 20_000, cached_input_tokens: 40_000 } },
      },
    });

    try {
      const { runImport } = await import('../src/import/index.js');
      const { getStatsForBroadcast } = await import('../src/db/queries.js');
      fs.writeFileSync(filePath, [sessionMeta, tokenCount].join('\n'));
      runImport({ source: 'codex', codexDir: isolatedCodexDir });

      if (!getDb) throw new Error('DB not initialized');
      const before = getDb().prepare(`
        SELECT model, cost_usd FROM events
        WHERE session_id = 'session-model-refresh' AND event_type = 'llm_response'
      `).get() as { model: string; cost_usd: number };
      assert.equal(before.model, 'gpt-5.6-sol');
      assert.ok(Math.abs(before.cost_usd - 0.92) < 0.0001);
      const statsBefore = getStatsForBroadcast();
      assert.ok(Math.abs(statsBefore.total_cost_usd - 0.92) < 0.0001);
      assert.equal(statsBefore.model_breakdown['gpt-5.6-sol'], 3);

      const turnContext = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } });
      fs.writeFileSync(filePath, [sessionMeta, turnContext, tokenCount].join('\n'));
      const refreshed = runImport({ source: 'codex', codexDir: isolatedCodexDir, force: true });

      assert.equal(refreshed.totalEventsImported, 0);
      assert.equal(refreshed.totalEventsRefreshed, 3);
      const after = getDb().prepare(`
        SELECT model, cost_usd FROM events
        WHERE session_id = 'session-model-refresh' AND event_type = 'llm_response'
      `).get() as { model: string; cost_usd: number };
      assert.equal(after.model, 'gpt-5.6-terra');
      assert.ok(Math.abs(after.cost_usd - 0.368) < 0.0001);

      const summary = getDb().prepare(`
        SELECT primary_model, cost_usd FROM session_trace_summary WHERE session_id = 'session-model-refresh'
      `).get() as { primary_model: string; cost_usd: number };
      assert.equal(summary.primary_model, 'gpt-5.6-terra');
      assert.ok(Math.abs(summary.cost_usd - 0.368) < 0.0001);

      const statsAfter = getStatsForBroadcast();
      assert.ok(Math.abs(statsAfter.total_cost_usd - 0.368) < 0.0001);
      assert.equal(statsAfter.model_breakdown['gpt-5.6-sol'], undefined);
      assert.equal(statsAfter.model_breakdown['gpt-5.6-terra'], 3);
    } finally {
      fs.rmSync(isolatedCodexDir, { recursive: true, force: true });
    }
  });

  test('a Codex model refresh that prices a formerly unpriced row labels it an estimate', async () => {
    const isolatedCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-refresh-label-'));
    const sessionsDir = path.join(isolatedCodexDir, 'sessions', '2026', '07', '12');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(isolatedCodexDir, 'config.toml'), 'model = "unpriced-model"\n');
    const filePath = path.join(sessionsDir, 'refresh-label.jsonl');
    const sessionMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-12T11:00:00Z',
      payload: { id: 'session-refresh-label', cwd: '/tmp', timestamp: '2026-07-12T11:00:00Z' },
    });
    const tokenCount = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-12T11:01:00Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100_000, output_tokens: 20_000 } } },
    });
    const labelOf = () => getDb!().prepare(`
      SELECT cost_usd, cost_source FROM events
      WHERE session_id = 'session-refresh-label' AND event_type = 'llm_response'
    `).get() as { cost_usd: number | null; cost_source: string | null };

    try {
      const { runImport } = await import('../src/import/index.js');
      fs.writeFileSync(filePath, [sessionMeta, tokenCount].join('\n'));
      runImport({ source: 'codex', codexDir: isolatedCodexDir });
      assert.deepEqual(labelOf(), { cost_usd: null, cost_source: null });

      const turnContext = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } });
      fs.writeFileSync(filePath, [sessionMeta, turnContext, tokenCount].join('\n'));
      runImport({ source: 'codex', codexDir: isolatedCodexDir, force: true });
      const after = labelOf();
      assert.ok(after.cost_usd !== null && after.cost_usd > 0);
      assert.equal(after.cost_source, 'estimated');
    } finally {
      fs.rmSync(isolatedCodexDir, { recursive: true, force: true });
    }
  });

  test('dry run does not write to database', async () => {
    const { runImport } = await import('../src/import/index.js');

    const result = runImport({
      source: 'claude-code',
      claudeDir,
      dryRun: true,
    });

    assert.equal(result.totalEventsFound, 2);
    assert.equal(result.totalEventsImported, 2);

    const eventsRes = await fetch(`${baseUrl}/api/events?limit=10`);
    const body = await eventsRes.json() as { total: number };
    assert.equal(body.total, 0);
  });

  test('imported events get auto-calculated cost', async () => {
    const { runImport } = await import('../src/import/index.js');

    runImport({ source: 'claude-code', claudeDir, force: true });

    const eventsRes = await fetch(`${baseUrl}/api/events?limit=10&source=import`);
    const body = await eventsRes.json() as { events: Array<Record<string, unknown>> };

    const toolEvent = body.events.find(e => e.event_type === 'tool_use');
    assert.ok(toolEvent);
    assert.ok(toolEvent.cost_usd !== null, 'Expected auto-calculated cost_usd');
  });

  test('import_state table tracks imported files', async () => {
    const { runImport } = await import('../src/import/index.js');

    runImport({ source: 'claude-code', claudeDir });

    if (!getDb) throw new Error('DB not initialized');
    const state = getDb().prepare('SELECT * FROM import_state').all() as Array<Record<string, unknown>>;
    assert.equal(state.length, 1);
    assert.equal(state[0].source, 'claude-code');
    assert.equal(state[0].events_imported, 2);
    assert.ok(typeof state[0].file_hash === 'string');
  });

  test('full imports cache unchanged files even when no events are parsed', async () => {
    const isolatedClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-empty-import-'));
    const projectDir = path.join(isolatedClaudeDir, 'projects', 'empty-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const emptyFile = path.join(projectDir, 'empty-session.jsonl');
    fs.writeFileSync(emptyFile, `${JSON.stringify({ data: { status: 'starting' } })}\n`);

    try {
      const { runImport } = await import('../src/import/index.js');

      const first = runImport({ source: 'claude-code', claudeDir: isolatedClaudeDir });
      assert.equal(first.totalFiles, 1);
      assert.equal(first.totalEventsFound, 0);
      assert.equal(first.skippedFiles, 0);

      if (!getDb) throw new Error('DB not initialized');
      const state = getDb().prepare(
        'SELECT file_hash, events_imported FROM import_state WHERE file_path = ?',
      ).get(emptyFile) as { file_hash: string; events_imported: number } | undefined;
      assert.ok(state, 'import_state should cache zero-event files after a full import');
      assert.equal(state?.events_imported, 0);
      assert.ok(typeof state?.file_hash === 'string' && state.file_hash.length > 0);

      const second = runImport({ source: 'claude-code', claudeDir: isolatedClaudeDir });
      assert.equal(second.totalFiles, 1);
      assert.equal(second.skippedFiles, 1);
      assert.equal(second.totalEventsFound, 0);
      assert.equal(second.totalEventsImported, 0);
    } finally {
      fs.rmSync(isolatedClaudeDir, { recursive: true, force: true });
    }
  });

  test('runImport excludes matching paths before parsing', async () => {
    const isolatedClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-exclude-import-'));
    const projectDir = path.join(isolatedClaudeDir, 'projects', 'proj-a');
    const excludedDir = path.join(projectDir, 'vercel-plugin');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(excludedDir, { recursive: true });

    const includedFile = path.join(projectDir, 'session-a.jsonl');
    const excludedFile = path.join(excludedDir, 'skill-injections.jsonl');
    fs.writeFileSync(includedFile, JSON.stringify({
      type: 'assistant',
      sessionId: 'included-session',
      timestamp: '2026-02-01T10:00:00Z',
      costUSD: 0.01,
    }));
    fs.writeFileSync(excludedFile, JSON.stringify({
      timestamp: '2026-03-20T12:34:40.479Z',
      event: 'prompt-skill-injection',
    }));

    try {
      const { runImport } = await import('../src/import/index.js');
      const result = runImport({
        source: 'claude-code',
        claudeDir: isolatedClaudeDir,
        excludePatterns: ['vercel-plugin'],
      });

      assert.equal(result.totalFiles, 1);
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].path, includedFile);

      if (!getDb) throw new Error('DB not initialized');
      const excludedState = getDb().prepare(
        'SELECT * FROM import_state WHERE file_path = ?',
      ).get(excludedFile);
      assert.equal(excludedState, undefined);
    } finally {
      fs.rmSync(isolatedClaudeDir, { recursive: true, force: true });
    }
  });
});

describe('Import skips files unchanged on disk', () => {
  // WHY: Use an unreadable file to show that the importer skipped it without opening it.
  function claudeFixture(prefix: string): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const file = path.join(dir, 'projects', 'proj', 'stat-gate-session.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant', sessionId: 'stat-gate-session', uuid: 'uuid-stat-gate-0', timestamp: '2026-02-01T10:00:00Z',
      message: { id: 'msg_stat_gate', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 2, output_tokens: 3 } },
    }));
    return { dir, file };
  }

  function codexFixture(prefix: string): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const file = path.join(dir, 'sessions', '2026', '02', '01', 'stat-gate-rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-02-01T11:00:00Z', payload: { id: 'stat-gate-codex', cwd: '/home/user/project', timestamp: '2026-02-01T11:00:00Z' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-02-01T11:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 100 } } } }),
    ].join('\n'));
    return { dir, file };
  }

  test('a Claude transcript whose size and mtime match is not read again', async () => {
    const { runImport } = await import('../src/import/index.js');
    const { dir, file } = claudeFixture('agentmonitor-stat-gate-claude-');
    runImport({ source: 'claude-code', claudeDir: dir });
    fs.chmodSync(file, 0o000);
    try {
      const result = runImport({ source: 'claude-code', claudeDir: dir });
      assert.equal(result.skippedFiles, 1);
    } finally {
      fs.chmodSync(file, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Codex rollout whose size and mtime match is not read again', async () => {
    const { runImport } = await import('../src/import/index.js');
    const { dir, file } = codexFixture('agentmonitor-stat-gate-codex-');
    runImport({ source: 'codex', codexDir: dir });
    fs.chmodSync(file, 0o000);
    try {
      const result = runImport({ source: 'codex', codexDir: dir });
      assert.equal(result.skippedFiles, 1);
    } finally {
      fs.chmodSync(file, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a same-size rewrite with a new mtime is read again', async () => {
    const { runImport } = await import('../src/import/index.js');
    const { dir, file } = claudeFixture('agentmonitor-stat-gate-rewrite-');
    runImport({ source: 'claude-code', claudeDir: dir });
    const original = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, original.replace('uuid-stat-gate-0', 'uuid-stat-gate-9'));
    const later = new Date(fs.statSync(file).mtimeMs + 5_000);
    fs.utimesSync(file, later, later);

    const result = runImport({ source: 'claude-code', claudeDir: dir });

    assert.equal(result.skippedFiles, 0);
    assert.equal(result.totalEventsImported, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an append that keeps the mtime is read again by its size', async () => {
    const { runImport } = await import('../src/import/index.js');
    const { dir, file } = claudeFixture('agentmonitor-stat-gate-size-');
    const pinned = new Date('2026-02-01T12:00:00Z');
    fs.utimesSync(file, pinned, pinned);
    runImport({ source: 'claude-code', claudeDir: dir });
    fs.appendFileSync(file, '\n' + JSON.stringify({
      type: 'assistant', sessionId: 'stat-gate-session', uuid: 'uuid-stat-gate-1', timestamp: '2026-02-01T10:01:00Z',
      message: { id: 'msg_stat_gate_1', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 2, output_tokens: 3 } },
    }));
    fs.utimesSync(file, pinned, pinned);

    const result = runImport({ source: 'claude-code', claudeDir: dir });

    assert.equal(result.totalEventsImported, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a hash cleared to force a re-import still reads the file', async () => {
    const { runImport } = await import('../src/import/index.js');
    const { dir } = codexFixture('agentmonitor-stat-gate-invalidated-');
    runImport({ source: 'codex', codexDir: dir });
    if (!getDb) throw new Error('Database not initialized');
    getDb().prepare("UPDATE import_state SET file_hash = '' WHERE source = 'codex'").run();

    const result = runImport({ source: 'codex', codexDir: dir });

    assert.equal(result.skippedFiles, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a touched but unchanged file is read once, then skipped by its new mtime', async () => {
    const { runImport } = await import('../src/import/index.js');
    const { dir, file } = claudeFixture('agentmonitor-stat-gate-touch-');
    runImport({ source: 'claude-code', claudeDir: dir });
    const later = new Date(fs.statSync(file).mtimeMs + 5_000);
    fs.utimesSync(file, later, later);
    runImport({ source: 'claude-code', claudeDir: dir });
    fs.chmodSync(file, 0o000);
    try {
      const result = runImport({ source: 'claude-code', claudeDir: dir });
      assert.equal(result.skippedFiles, 1);
    } finally {
      fs.chmodSync(file, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
