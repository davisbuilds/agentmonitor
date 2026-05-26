import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageAuthor } from '../frontend/src/lib/session-roles.ts';

const tr = (...types: string[]) => JSON.stringify(types.map((type) => ({ type })));

test('classifyMessageAuthor distinguishes you, assistant, and tool turns', () => {
  // Assistant turns (text, thinking, or tool_use calls) are always the model.
  assert.equal(classifyMessageAuthor({ role: 'assistant', content: tr('text') }), 'assistant');
  assert.equal(classifyMessageAuthor({ role: 'assistant', content: tr('tool_use') }), 'assistant');
  assert.equal(classifyMessageAuthor({ role: 'assistant', content: tr('thinking', 'text') }), 'assistant');

  // A user turn made entirely of tool_result blocks is the environment, not the human.
  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('tool_result') }), 'tool');
  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('tool_result', 'tool_result') }), 'tool');

  // Genuine human input — plain text, or text mixed with a tool_result.
  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('text') }), 'you');
  assert.equal(classifyMessageAuthor({ role: 'user', content: tr('text', 'tool_result') }), 'you');

  // Non-JSON / empty content falls back to plain user text.
  assert.equal(classifyMessageAuthor({ role: 'user', content: 'hello there' }), 'you');
  assert.equal(classifyMessageAuthor({ role: 'user', content: '' }), 'you');
});
