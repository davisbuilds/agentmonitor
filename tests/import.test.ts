import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseClaudeCodeFile, discoverClaudeCodeLogs } from '../src/import/claude-code.js';
import { parseCodexFile, discoverCodexLogs } from '../src/import/codex.js';

// ─── Claude Code parser unit tests ──────────────────────────────────────

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
    // Deltas: 0.05, 0.07, 0.08
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

// ─── Claude Code discovery ──────────────────────────────────────────────

describe('Claude Code log discovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-disc-test-'));
    // Create mock directory structure
    fs.mkdirSync(path.join(tmpDir, 'projects', 'project-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'project-b'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'sess-1.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'sess-2.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-b', 'sess-3.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'project-a', 'other.txt'), '');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('discovers all .jsonl files across project directories', () => {
    const files = discoverClaudeCodeLogs(tmpDir);
    assert.equal(files.length, 3);
    assert.ok(files.every(f => f.endsWith('.jsonl')));
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

// ─── Codex parser unit tests ────────────────────────────────────────────

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
    // session_meta → session_start + session_end
    assert.ok(events.length >= 1);
    assert.equal(events[0].event_type, 'session_start');
    assert.equal(events[0].session_id, 'cdx-1');
    assert.equal(events[0].agent_type, 'codex');
    assert.equal(events[0].status, 'success');
    assert.equal(events[0].source, 'import');
    const meta = events[0].metadata as Record<string, unknown>;
    assert.equal(meta.cli_version, 'codex-cli/1.0');
    assert.equal(meta.cwd, '/home/user/project');
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
    assert.equal(tokenEvent.tokens_in, 2500);
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
    // First delta: 1000, 200
    assert.equal(tokenEvents[0].tokens_in, 1000);
    assert.equal(tokenEvents[0].tokens_out, 200);
    // Second delta: 2000, 500
    assert.equal(tokenEvents[1].tokens_in, 2000);
    assert.equal(tokenEvents[1].tokens_out, 500);
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
    // Should use filename since there's no session_meta
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

// ─── Codex discovery ────────────────────────────────────────────────────

describe('Codex log discovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cdx-disc-'));
    // Create mock ~/.codex/sessions/YYYY/MM/DD/ structure
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

// ─── Integration: import orchestrator with DB ───────────────────────────

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
  server = createApp({ serveStatic: false }).listen(0);
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

  before(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-orch-claude-'));
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-orch-codex-'));

    // Mock Claude Code logs
    fs.mkdirSync(path.join(claudeDir, 'projects', 'my-project'), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'projects', 'my-project', 'session-abc.jsonl'),
      [
        JSON.stringify({ type: 'tool_use', sessionId: 'session-abc', name: 'Bash', model: 'claude-sonnet-4-5-20250929', timestamp: '2026-02-01T10:00:00Z', usage: { input_tokens: 1000, output_tokens: 200 } }),
        JSON.stringify({ type: 'assistant', sessionId: 'session-abc', model: 'claude-sonnet-4-5-20250929', timestamp: '2026-02-01T10:01:00Z', costUSD: 0.01, usage: { input_tokens: 2000, output_tokens: 500 } }),
      ].join('\n'),
    );

    // Mock Codex logs (new format: session_meta + event_msg token_count)
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

    // Verify events in DB via API
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
    assert.equal(result.totalEventsImported, 3); // session_start + llm_response + session_end

    // Verify events in DB
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
      force: true,
    });

    assert.equal(result.totalFiles, 2);
    assert.equal(result.totalEventsImported, 5); // 2 claude + 3 codex
  });

  test('skips unchanged files on re-import', async () => {
    const { runImport } = await import('../src/import/index.js');

    // First import
    const result1 = runImport({ source: 'claude-code', claudeDir });
    assert.equal(result1.totalEventsImported, 2);

    // Second import — should skip since file hash matches
    const result2 = runImport({ source: 'claude-code', claudeDir });
    assert.equal(result2.skippedFiles, 1);
    assert.equal(result2.totalEventsImported, 0);
  });

  test('--force re-imports even if file unchanged', async () => {
    const { runImport } = await import('../src/import/index.js');

    // First import
    runImport({ source: 'claude-code', claudeDir });

    // Force re-import — events deduplicated by event_id but file isn't skipped
    const result2 = runImport({ source: 'claude-code', claudeDir, force: true });
    assert.equal(result2.skippedFiles, 0);
    assert.equal(result2.totalFiles, 1);
    // All events are duplicates since event_ids match
    assert.equal(result2.totalDuplicates, 2);
    assert.equal(result2.totalEventsImported, 0);
  });

  test('dry run does not write to database', async () => {
    const { runImport } = await import('../src/import/index.js');

    const result = runImport({
      source: 'claude-code',
      claudeDir,
      dryRun: true,
    });

    assert.equal(result.totalEventsFound, 2);
    assert.equal(result.totalEventsImported, 2); // reported as "would import"

    // Verify nothing written to DB
    const eventsRes = await fetch(`${baseUrl}/api/events?limit=10`);
    const body = await eventsRes.json() as { total: number };
    assert.equal(body.total, 0);
  });

  test('imported events get auto-calculated cost', async () => {
    const { runImport } = await import('../src/import/index.js');

    runImport({ source: 'claude-code', claudeDir, force: true });

    // The tool_use event has model + tokens but no cost
    // insertEvent should auto-calculate
    const eventsRes = await fetch(`${baseUrl}/api/events?limit=10&source=import`);
    const body = await eventsRes.json() as { events: Array<Record<string, unknown>> };

    const toolEvent = body.events.find(e => e.event_type === 'tool_use');
    assert.ok(toolEvent);
    // model: claude-sonnet-4-5-20250929, tokens_in: 1000, tokens_out: 200
    // Cost should be auto-calculated
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
});
