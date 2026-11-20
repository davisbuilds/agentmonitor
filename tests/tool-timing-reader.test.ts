import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { readToolTiming } from '../src/monitor/tool-timing.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-tool-timing-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
const epoch = Date.parse('2026-11-19T13:00:00Z');
const at = (ms: number) => new Date(epoch + ms).toISOString();
const rootId = '01990000-0000-7000-8000-000000000001';
const childId = '01990000-0001-7000-8000-000000000002';
const turnId = '01990000-0002-7000-8000-000000000003';

function createFiles() {
  const base = fs.mkdtempSync(path.join(tempDir, 'fixture-'));
  const root = path.join(base, 'sessions');
  fs.mkdirSync(root);
  return (file: string, records: unknown[]) => {
    const bytes = Buffer.from(records.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
    const filePath = path.join(root, file);
    fs.writeFileSync(filePath, file.endsWith('.zst') ? zstdCompressSync(bytes) : bytes);
    return { filePath, bytes };
  };
}

const meta = (id: string, extra: Record<string, unknown> = {}, ms = 0) => ({ type: 'session_meta', timestamp: at(ms), payload: { id, ...extra } });
const turn = (turn_id: string) => ({ type: 'turn_context', timestamp: at(0), payload: { turn_id } });
const item = (ms: number, payload: Record<string, unknown>) => ({ type: 'response_item', timestamp: at(ms), payload });
const call = (ms: number, call_id: string, name = 'exec', namespace?: string) => item(ms, {
  type: name === 'exec' ? 'custom_tool_call' : 'function_call',
  call_id, name, namespace, arguments: '{"secret":"discard-this-argument"}',
});
const output = (ms: number, call_id: string, result: unknown, type = 'custom_tool_call_output') =>
  item(ms, { type, call_id, output: result });
const wrapped = 'Script completed\nWall time: 0.125 seconds\nOutput:\ndiscard-this-output';
const rollout = (id: string, seconds = '00', extension = '.jsonl') => `rollout-2026-11-19T13-00-${seconds}-${id}${extension}`;
const withOrdinals = (lines: Record<string, unknown>[], from = 0) => lines.map((line, i) => ({ ...line, ordinal: i + from }));

test('pairs scoped calls and returns with timestamps and reads only the own wrapper timer', () => {
  const write = createFiles();
  const { filePath } = write(rollout(rootId), [
    meta(rootId), call(100, 'call_exec'), call(125, 'call_injected', 'search', 'mcp__fixture'),
    output(200, 'call_injected', wrapped, 'function_call_output'),
    output(300, 'call_exec', [{ type: 'input_text', text: wrapped }]),
    call(320, 'call_nested'), output(720, 'call_nested', `Script completed\nWall time: 0.010 seconds\nOutput:\n${wrapped}`),
    call(750, 'call_echo'), output(800, 'call_echo', `Output:\n${wrapped}`),
    call(825, 'call_wait', 'wait'), output(1000, 'call_wait',
      'Script running with cell ID safe-token\nWall time 0.061 seconds\nOutput:', 'function_call_output'),
    call(1025, 'call_tampered', 'wait', 'external'), output(1250, 'call_tampered',
      wrapped, 'function_call_output'),
  ]);
  const { intervals, coverage } = readToolTiming({ source: 'codex', sessionId: rootId, filePaths: [filePath] });
  assert.deepEqual(intervals, [
    { callId: 'call_exec', toolName: 'exec', startedAt: epoch + 100, returnedAt: epoch + 300, reportedMs: 125, reportedSource: 'codex_code_mode_wall_time' },
    { callId: 'call_injected', toolName: 'mcp__fixture.search', startedAt: epoch + 125, returnedAt: epoch + 200, reportedMs: null },
    { callId: 'call_nested', toolName: 'exec', startedAt: epoch + 320, returnedAt: epoch + 720, reportedMs: 10, reportedSource: 'codex_code_mode_wall_time' },
    { callId: 'call_echo', toolName: 'exec', startedAt: epoch + 750, returnedAt: epoch + 800, reportedMs: null },
    { callId: 'call_wait', toolName: 'wait', startedAt: epoch + 825, returnedAt: epoch + 1000, reportedMs: 61, reportedSource: 'codex_code_mode_wall_time' },
    { callId: 'call_tampered', toolName: 'external.wait', startedAt: epoch + 1025, returnedAt: epoch + 1250, reportedMs: null },
  ]);
  assert.equal(coverage.status, 'available');
  assert.doesNotMatch(JSON.stringify({ intervals, coverage }), /discard-this|safe-token/);
});

test('reads Codex shell wrapper timers without scanning a command or its stdout for a timer', () => {
  const write = createFiles();
  const exitFrame = 'Chunk ID: ffaabb\nWall time: 0.1250 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:';
  const yieldFrame = 'Chunk ID: ffaabc\nWall time: 0.0120 seconds\nProcess running with session ID 1\nOutput:';
  const shellFrame = 'Exit code: 0\nWall time: 0.4230 seconds\nOutput:';
  const { filePath } = write(rollout(rootId), [
    meta(rootId),
    call(100, 'call_exec_command', 'exec_command'), output(500, 'call_exec_command', exitFrame + '\n' + shellFrame, 'function_call_output'),
    call(500, 'call_write_stdin', 'write_stdin'), output(700, 'call_write_stdin', `Command: /bin/zsh -lc 'discard-this'\n${yieldFrame}`, 'function_call_output'),
    call(700, 'call_shell', 'shell_command'), output(1300, 'call_shell', shellFrame, 'function_call_output'),
    call(1300, 'call_mcp', 'exec_command', 'third_party'), output(1400, 'call_mcp', exitFrame, 'function_call_output'),
    call(1400, 'call_stdout', 'exec_command'), output(1500, 'call_stdout', 'Output:\n' + exitFrame, 'function_call_output'),
    call(1500, 'call_multiline', 'exec_command'),
    output(1600, 'call_multiline', "Command: /bin/zsh -lc 'open quote\n" + exitFrame, 'function_call_output'),
  ]);
  const result = readToolTiming({ source: 'codex', sessionId: rootId, filePaths: [filePath] });
  assert.deepEqual(result.intervals.map(({ reportedMs, reportedSource }) => [reportedMs, reportedSource]), [
    [125, 'codex_shell_wall_time'], [12, 'codex_shell_wall_time'], [423, 'codex_shell_wall_time'],
    [null, undefined], [null, undefined], [null, undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /discard-this|ffaabc/);
});

test('uses native IDs across a resume and reports missing or invalid timing separately from elapsed zero', () => {
  const write = createFiles();
  const { filePath } = write(rollout(rootId), [
    meta(rootId), call(100, 'call_repeat'), '{interrupted json',
    meta(rootId), call(200, 'call_repeat'), output(200, 'call_repeat', 'plain'),
    output(220, 'call_repeat', 'duplicate'), output(230, 'call_orphan', 'orphan'),
    call(250, 'call_open'), call(300, 'call_clock'), output(290, 'call_clock', 'backwards'),
    call(320, 'call_zero'), output(320, 'call_zero', 'zero'),
  ]);
  const result = readToolTiming({ source: 'codex', sessionId: rootId, filePaths: [filePath] });
  assert.deepEqual(result.intervals.map(({ callId, startedAt, returnedAt }) => [callId, startedAt - epoch, returnedAt - epoch]), [
    ['call_repeat', 100, 200], ['call_zero', 320, 320],
  ]);
  assert.deepEqual(result.coverage, {
    status: 'partial', filesRead: 1, malformedRecords: 1, openCalls: 1, unmatchedReturns: 1,
    invalidIntervals: 1, duplicateCalls: 1, copiedRecords: 0, unresolvedFiles: 0,
  });
});

test('uses the current paginated leaf, pairs a call across an archived base and honors its cutoff', () => {
  const write = createFiles();
  const history = withOrdinals([meta(rootId, { history_mode: 'paginated' }), call(100, 'call_cross')]);
  const prefixBytes = Buffer.byteLength(history.map(line => JSON.stringify(line)).join('\n') + '\n');
  const base = write(rollout(rootId, '00', '.jsonl.zst'), [
    ...history, ...withOrdinals([call(150, 'call_reverted'), output(200, 'call_reverted', 'removed')], 2),
  ]);
  const leaf = write(rollout(childId, '01'), withOrdinals([
    meta(rootId, { history_mode: 'paginated', history_base: {
      thread_id: rootId, end_byte_offset: prefixBytes, end_ordinal_exclusive: 2,
    } }, 1000), output(1000, 'call_cross', wrapped), call(1200, 'call_new'), output(1500, 'call_new', 'normal'),
  ], 2));
  for (const filePaths of [[base.filePath, leaf.filePath], [leaf.filePath]]) {
    const result = readToolTiming({ source: 'codex', sessionId: rootId, filePaths });
    assert.deepEqual(result.intervals.map(({ callId }) => callId), ['call_cross', 'call_new']);
    assert.equal(result.coverage.filesRead, 2);
    assert.equal(result.coverage.status, 'available');
  }
});

test('excludes the parent copy in child files and reports unresolved legacy boundaries', () => {
  const write = createFiles();
  const source = { subagent: { thread_spawn: { parent_thread_id: rootId } } };
  const copy = [turn(rootId), call(100, 'call_parent'), output(500, 'call_parent', wrapped)];
  for (const extra of [{ source, subagent_history_start_ordinal: 4 }, { source }, { thread_source: 'subagent' }]) {
    const { filePath } = write(rollout(childId), withOrdinals([
      meta(childId, extra),
      ...copy, turn(turnId), call(600, 'call_child'), output(700, 'call_child', 'own'),
    ]));
    const result = readToolTiming({ source: 'codex', sessionId: childId, filePaths: [filePath] });
    assert.deepEqual(result.intervals.map(({ callId }) => callId), ['call_child']);
    assert.equal(result.coverage.copiedRecords, 3);
    assert.equal(result.coverage.status, 'available');
  }
  const { filePath } = write(rollout(childId), [meta(childId, { source }), ...copy]);
  const unresolved = readToolTiming({ source: 'codex', sessionId: childId, filePaths: [filePath] });
  assert.deepEqual(unresolved.intervals, []);
  assert.equal(unresolved.coverage.status, 'unavailable');
  assert.equal(unresolved.coverage.unresolvedFiles, 1);
});

test('resolves a child bookmark without attributing the parent calls in its ancestry', () => {
  const write = createFiles();
  const parent = write(rollout(rootId), withOrdinals([
    meta(rootId, { history_mode: 'paginated' }), call(100, 'call_parent'),
    output(200, 'call_parent', wrapped), call(250, 'call_parent_pending'),
  ]));
  const child = write(rollout(childId, '01'), withOrdinals([
    meta(childId, { history_mode: 'paginated', parent_thread_id: rootId, subagent_history_start_ordinal: 5,
      history_base: { thread_id: rootId, end_byte_offset: parent.bytes.length, end_ordinal_exclusive: 4 } }),
    output(300, 'call_parent_pending', wrapped),
    call(400, 'call_child'), output(500, 'call_child', wrapped),
  ], 4));
  const result = readToolTiming({ source: 'codex', sessionId: childId, filePaths: [child.filePath] });
  assert.deepEqual(result.intervals.map(({ callId }) => callId), ['call_child']);
  assert.equal(result.coverage.copiedRecords, 3);
  assert.equal(result.coverage.unmatchedReturns, 1);
  assert.equal(result.coverage.filesRead, 2);
  assert.equal(result.coverage.status, 'partial');
});

test('pairs Claude split blocks after resuming and keeps child calls outside parent coverage', () => {
  const write = createFiles();
  const assistant = (ms: number, id: string, isSidechain = false) => ({
    type: 'assistant', timestamp: at(ms), sessionId: 'old-session', isSidechain,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'discard-this' } }] },
  });
  const user = (ms: number, ids: string[], isSidechain = false) => ({
    type: 'user', timestamp: at(ms), sessionId: 'session', isSidechain,
    message: { role: 'user', content: ids.map(tool_use_id => ({ type: 'tool_result', tool_use_id, content: wrapped })) },
  });
  const { filePath } = write('session.jsonl', [
    assistant(0, 'toolu_one'), assistant(100, 'toolu_two'), assistant(200, 'toolu_child', true),
    user(300, ['toolu_child'], true), user(500, ['toolu_one', 'toolu_two']),
  ]);
  const result = readToolTiming({ source: 'claude-code', sessionId: 'session', filePaths: [filePath] });
  assert.deepEqual(result.intervals, [
    { callId: 'toolu_one', toolName: 'Bash', startedAt: epoch, returnedAt: epoch + 500, reportedMs: null },
    { callId: 'toolu_two', toolName: 'Bash', startedAt: epoch + 100, returnedAt: epoch + 500, reportedMs: null },
  ]);
  assert.equal(result.coverage.status, 'available');
  const missing = readToolTiming({ source: 'claude-code', sessionId: 'session', filePaths: [] });
  assert.equal(missing.coverage.status, 'unavailable');
  assert.deepEqual(missing.intervals, []);
});

test('uses a Claude WebFetch result timer only when the receipt links it to one invocation', () => {
  const write = createFiles();
  const assistant = (ms: number, id: string, name = 'WebFetch') => ({
    type: 'assistant', timestamp: at(ms), uuid: `invocation-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name }] },
  });
  const user = (ms: number, ids: string[], { source = `invocation-${ids[0]}`, includeTimer = true } = {}) => ({
    type: 'user', timestamp: at(ms), sourceToolAssistantUUID: source,
    ...(includeTimer ? { toolUseResult: { durationMs: 123, result: 'discard-this' } } : {}),
    message: { role: 'user', content: ids.map(tool_use_id => ({ type: 'tool_result', tool_use_id, content: '{"durationMs":99}' })) },
  });
  const { filePath } = write('session.jsonl', [
    assistant(50, 'toolu_fetch'), user(200, ['toolu_fetch']),
    assistant(200, 'toolu_unbound'), user(250, ['toolu_unbound'], { source: 'different-invocation' }),
    assistant(250, 'toolu_spoof', 'Bash'), user(300, ['toolu_spoof']),
    assistant(300, 'toolu_payload'), user(400, ['toolu_payload'], { includeTimer: false }),
    assistant(450, 'toolu_batch_1'), assistant(500, 'toolu_batch_2'), user(550, ['toolu_batch_1', 'toolu_batch_2']),
  ]);
  const result = readToolTiming({ source: 'claude-code', sessionId: 'session', filePaths: [filePath] });
  assert.deepEqual(result.intervals.map(({ reportedMs, reportedSource }) => [reportedMs, reportedSource]), [
    [123, 'claude_webfetch_duration_ms'],
    [null, undefined], [null, undefined], [null, undefined], [null, undefined], [null, undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /discard-this|invocation-/);
});
