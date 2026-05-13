import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLivePrivacyPolicy,
  normalizeClaudeBlock,
  normalizeCodexItem,
  normalizePlanState,
} from '../src/live/normalize.js';

test('normalizeClaudeBlock maps user text to user_message', () => {
  const item = normalizeClaudeBlock('user', { type: 'text', text: 'Open the config file' }, '2026-03-23T12:00:00Z');

  assert.ok(item);
  assert.equal(item.kind, 'user_message');
  assert.equal(item.created_at, '2026-03-23T12:00:00Z');
  assert.deepEqual(item.payload, { text: 'Open the config file' });
});

test('normalizeClaudeBlock maps assistant thinking to reasoning', () => {
  const item = normalizeClaudeBlock('assistant', { type: 'thinking', thinking: 'I should inspect the repo layout first.' });

  assert.ok(item);
  assert.equal(item.kind, 'reasoning');
  assert.deepEqual(item.payload, { text: 'I should inspect the repo layout first.' });
});

test('normalizeClaudeBlock maps tool use and tool result blocks', () => {
  const call = normalizeClaudeBlock('assistant', {
    type: 'tool_use',
    id: 'toolu_123',
    name: 'Read',
    input: { file_path: '/tmp/demo.ts' },
  });
  const result = normalizeClaudeBlock('assistant', {
    type: 'tool_result',
    tool_use_id: 'toolu_123',
    content: 'file contents',
    is_error: false,
  });

  assert.ok(call);
  assert.equal(call.kind, 'tool_call');
  assert.equal(call.source_item_id, 'toolu_123');
  assert.deepEqual(call.payload, { tool_name: 'Read', input: { file_path: '/tmp/demo.ts' } });

  assert.ok(result);
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.source_item_id, 'toolu_123');
  assert.equal(result.status, 'success');
});

test('normalizeCodexItem maps command and diff records', () => {
  const command = normalizeCodexItem({
    type: 'commandExecution',
    id: 'cmd-1',
    created_at: '2026-03-23T12:01:00Z',
    payload: { command: 'pnpm build', cwd: '/repo', exitCode: 0 },
  });
  const diff = normalizeCodexItem({
    type: 'turn/diff/updated',
    id: 'diff-1',
    payload: { unified_diff: '@@ -1 +1 @@' },
  });

  assert.ok(command);
  assert.equal(command.kind, 'command_execution');
  assert.equal(command.source_item_id, 'cmd-1');
  assert.deepEqual(command.payload, { command: 'pnpm build', cwd: '/repo', exitCode: 0 });

  assert.ok(diff);
  assert.equal(diff.kind, 'diff_snapshot');
});

test('normalizeCodexItem maps every reserved live item kind', () => {
  const cases = [
    ['fileChange', 'file_change'],
    ['mcpToolCall', 'tool_call'],
    ['tool_result', 'tool_result'],
    ['plan', 'plan_update'],
    ['turn/plan/updated', 'plan_update'],
    ['diff', 'diff_snapshot'],
    ['reasoning', 'reasoning'],
    ['assistant_message', 'assistant_message'],
    ['user_message', 'user_message'],
    ['status', 'status_change'],
  ] as const;

  for (const [type, kind] of cases) {
    const item = normalizeCodexItem({
      type,
      id: `${type}-1`,
      status: 'completed',
      created_at: '2026-03-23T12:01:00Z',
      payload: { type },
    });
    assert.ok(item);
    assert.equal(item.kind, kind);
    assert.equal(item.source_item_id, `${type}-1`);
    assert.equal(item.status, 'completed');
  }
});

test('normalizeCodexItem returns null for unsupported records', () => {
  const item = normalizeCodexItem({ type: 'unhandled-item-type', payload: { foo: 'bar' } });
  assert.equal(item, null);
});

test('applyLivePrivacyPolicy redacts disabled prompt, reasoning, and tool argument capture', () => {
  const basePolicy = {
    capturePrompts: false,
    captureReasoning: false,
    captureToolArguments: false,
    diffPayloadMaxBytes: 20,
  };

  assert.deepEqual(
    applyLivePrivacyPolicy({ kind: 'user_message', payload: { text: 'secret prompt' } }, basePolicy).payload,
    { redacted: true, reason: 'prompt_capture_disabled' },
  );
  assert.deepEqual(
    applyLivePrivacyPolicy({ kind: 'reasoning', payload: { text: 'hidden chain' } }, basePolicy).payload,
    { redacted: true, reason: 'reasoning_capture_disabled' },
  );
  assert.deepEqual(
    applyLivePrivacyPolicy({ kind: 'tool_call', payload: { tool_name: 'Bash', input: { command: 'pwd' } } }, basePolicy).payload,
    { tool_name: 'Bash', input: { redacted: true }, input_redacted: true },
  );
});

test('applyLivePrivacyPolicy truncates oversized diff snapshots without splitting UTF-8 characters', () => {
  const item = applyLivePrivacyPolicy(
    { kind: 'diff_snapshot', payload: { diff: '😀'.repeat(20) } },
    {
      capturePrompts: true,
      captureReasoning: true,
      captureToolArguments: true,
      diffPayloadMaxBytes: 25,
    },
  );

  assert.equal(item.payload.truncated, true);
  assert.equal(item.payload.reason, 'diff_payload_cap_exceeded');
  assert.equal(typeof item.payload.original_size_bytes, 'number');
  assert.equal(typeof item.payload.preview_json, 'string');

  const small = { kind: 'diff_snapshot' as const, payload: { diff: 'small' } };
  assert.equal(
    applyLivePrivacyPolicy(small, {
      capturePrompts: true,
      captureReasoning: true,
      captureToolArguments: true,
      diffPayloadMaxBytes: 100,
    }),
    small,
  );
});

test('normalizePlanState keeps only valid steps and standardizes labels', () => {
  const plan = normalizePlanState({
    summary: 'Complete the migration',
    steps: [
      { id: '1', step: 'Parse the input', status: 'completed' },
      { id: '2', title: 'Render the view', status: 'in_progress' },
      { bogus: true },
    ],
  });

  assert.equal(plan.summary, 'Complete the migration');
  assert.deepEqual(plan.steps, [
    { id: '1', label: 'Parse the input', status: 'completed' },
    { id: '2', label: 'Render the view', status: 'in_progress' },
  ]);
});
