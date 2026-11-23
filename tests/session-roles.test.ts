import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageAuthor } from '../frontend/src/lib/session-roles.ts';

const tr = (...types: string[]) => JSON.stringify(types.map((type) => ({ type })));

test('classifyMessageAuthor distinguishes you, assistant, and tool turns', () => {
  assert.equal(classifyMessageAuthor({ role: 'assistant', content: tr('text') }), 'assistant');
  assert.equal(classifyMessageAuthor({ role: 'assistant', content: tr('tool_use') }), 'assistant');
  assert.equal(classifyMessageAuthor({ role: 'assistant', content: tr('thinking', 'text') }), 'assistant');

  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('tool_result') }), 'tool');
  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('tool_result', 'tool_result') }), 'tool');

  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('text') }), 'you');
  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('text', 'tool_result') }), 'you');

  assert.equal(classifyMessageAuthor({ role: 'user', content: 'hello there' }), 'you');
  assert.equal(classifyMessageAuthor({ role: 'user', content: '' }), 'you');
});

test('classifyMessageAuthor calls a Codex developer turn instructions, not the assistant', () => {
  assert.equal(classifyMessageAuthor({ role: 'developer', content: tr('text') }), 'instructions');
  assert.equal(classifyMessageAuthor({ role: 'system', content: tr('text') }), 'instructions');
});

test('classifyMessageAuthor only calls a user turn "tool" when it is a non-empty tool_result array', () => {
  assert.equal(classifyMessageAuthor({ role: 'user', content: '[]' }), 'you');
  assert.equal(classifyMessageAuthor({ role: 'user', content: JSON.stringify({ type: 'tool_result' }) }), 'you');
  assert.equal(classifyMessageAuthor({ role: 'user', content: JSON.stringify([{ type: 'tool_result' }, null]) }), 'you');
});
