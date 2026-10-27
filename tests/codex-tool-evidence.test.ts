import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-tool-evidence-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { parseCodexSessionMessages } = await import('../src/parser/codex-sessions.js');
const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const watcher = await import('../src/watcher/index.js');

const SESSION = '019f1111-0000-7000-8000-000000000001';
const at = (second: number) => `2026-10-26T10:00:${String(second).padStart(2, '0')}.000Z`;
type Line = Record<string, unknown>;
const meta: Line = { type: 'session_meta', timestamp: at(0), payload: { id: SESSION, cwd: '/work/alpha', source: 'cli' } };
const prompt: Line = { type: 'response_item', timestamp: at(1), payload: { role: 'user', content: [{ type: 'input_text', text: 'build it' }] } };
const call = (callId: string, second: number): Line => ({
  type: 'response_item', timestamp: at(second),
  payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd: 'pnpm build' }) },
});
const customCall = (callId: string, second: number): Line => ({
  type: 'response_item', timestamp: at(second),
  payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: 'run()' },
});
const output = (callId: string, second: number, text: string): Line => ({
  type: 'response_item', timestamp: at(second), payload: { type: 'function_call_output', call_id: callId, output: text },
});
const customOutput = (callId: string, second: number, text: string): Line => ({
  type: 'response_item', timestamp: at(second),
  payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text }] },
});
const reply: Line = { type: 'response_item', timestamp: at(9), payload: { role: 'assistant', content: [{ type: 'output_text', text: 'built' }] } };
const jsonl = (lines: Line[]) => lines.map(line => JSON.stringify(line)).join('\n');
const blocks = (content: string) => JSON.parse(content) as Array<Record<string, unknown>>;

describe('Codex tool evidence from the rollout', () => {
  test('a call carries its call id, and its output becomes a receipt on the same message', () => {
    const parsed = parseCodexSessionMessages(jsonl([meta, prompt, call('call-1', 2), output('call-1', 5, 'Wall time: 3 seconds\nok'), reply]), SESSION);
    const callMessage = parsed.messages.find(message => message.has_tool_use === 1)!;
    assert.deepEqual(blocks(callMessage.content), [
      { type: 'tool_use', id: 'call-1', name: 'exec_command', input: { cmd: 'pnpm build' } },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'Wall time: 3 seconds\nok', timestamp: at(5), output_bytes: 23 },
    ]);
    assert.equal(callMessage.content_length, callMessage.content.length);
    assert.equal(parsed.toolCalls[0].tool_use_id, 'call-1');
  });

  test('a custom tool output given as content parts is read the same way', () => {
    const parsed = parseCodexSessionMessages(jsonl([meta, prompt, customCall('call-2', 2), customOutput('call-2', 4, 'Script completed')]), SESSION);
    const receipt = blocks(parsed.messages.find(message => message.has_tool_use === 1)!.content)[1];
    assert.deepEqual(receipt, { type: 'tool_result', tool_use_id: 'call-2', content: 'Script completed', timestamp: at(4), output_bytes: 16 });
  });

  test('without tool capture the receipt keeps the timing and size but no preview', () => {
    const parsed = parseCodexSessionMessages(
      jsonl([meta, prompt, call('call-1', 2), output('call-1', 5, 'secret output')]), SESSION, undefined, { captureToolOutput: false },
    );
    const receipt = blocks(parsed.messages.find(message => message.has_tool_use === 1)!.content)[1];
    assert.deepEqual(receipt, { type: 'tool_result', tool_use_id: 'call-1', content: '', timestamp: at(5), output_bytes: 13 });
  });

  test('a long output keeps only a bounded preview', () => {
    const parsed = parseCodexSessionMessages(jsonl([meta, prompt, call('call-1', 2), output('call-1', 5, 'x'.repeat(10_000))]), SESSION);
    const receipt = blocks(parsed.messages.find(message => message.has_tool_use === 1)!.content)[1];
    assert.equal((receipt.content as string).length, 2_000);
    assert.equal(receipt.output_bytes, 10_000);
  });

  test('receipts add no message and change no role or human-turn count', () => {
    const withOutputs = parseCodexSessionMessages(jsonl([meta, prompt, call('call-1', 2), output('call-1', 5, 'ok'), reply]), SESSION);
    const without = parseCodexSessionMessages(jsonl([meta, prompt, call('call-1', 2), reply]), SESSION);
    assert.deepEqual(withOutputs.messages.map(m => [m.ordinal, m.role, m.has_tool_use]), without.messages.map(m => [m.ordinal, m.role, m.has_tool_use]));
    assert.equal(withOutputs.metadata.message_count, without.metadata.message_count);
    assert.equal(withOutputs.metadata.user_message_count, without.metadata.user_message_count);
  });

  test('an output whose call is not in the rollout is dropped, not invented a call', () => {
    const parsed = parseCodexSessionMessages(jsonl([meta, prompt, output('call-gone', 5, 'ok'), reply]), SESSION);
    assert.equal(parsed.messages.some(message => message.content.includes('tool_result')), false);
    assert.equal(parsed.metadata.message_count, 2);
  });
});

describe('a receipt for a call stored by an earlier sync', () => {
  const dir = path.join(tempDir, 'sessions');
  before(() => {
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
    fs.mkdirSync(dir, { recursive: true });
  });
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('lands on the stored call message and its projected turn, in place', () => {
    const file = path.join(dir, `rollout-2026-10-26T10-00-00-${SESSION}.jsonl`);
    fs.writeFileSync(file, jsonl([meta, prompt, call('call-1', 2), reply]) + '\n');
    assert.equal(watcher.syncCodexSessionFileDetailed(getDb(), file).result, 'parsed');
    fs.appendFileSync(file, jsonl([output('call-1', 7, 'ok')]) + '\n');
    const outcome = watcher.syncCodexSessionFileDetailed(getDb(), file);
    assert.equal(outcome.parse, 'resumed', 'the output arrives in a continued parse');

    const sessionId = path.basename(file, '.jsonl');
    const stored = getDb().prepare('SELECT ordinal, content FROM messages WHERE session_id = ? AND ordinal = 1').get(sessionId) as { ordinal: number; content: string };
    assert.deepEqual(blocks(stored.content)[1], { type: 'tool_result', tool_use_id: 'call-1', content: 'ok', timestamp: at(7), output_bytes: 2 });
    const items = getDb().prepare(`
      SELECT i.ordinal, i.kind, i.source_item_id, i.created_at FROM session_items i JOIN session_turns t ON t.id = i.turn_id
      WHERE t.session_id = ? AND t.source_turn_id = 'codex-message:1' ORDER BY i.ordinal
    `).all(sessionId);
    assert.deepEqual(items, [
      { ordinal: 0, kind: 'tool_call', source_item_id: 'call-1', created_at: at(2) },
      { ordinal: 1, kind: 'tool_result', source_item_id: 'call-1', created_at: at(7) },
    ]);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n, 3);
  });
});
