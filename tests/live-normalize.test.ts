import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

test('normalizeCodexItem returns null for unsupported records', () => {
  const item = normalizeCodexItem({ type: 'unhandled-item-type', payload: { foo: 'bar' } });
  assert.equal(item, null);
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
