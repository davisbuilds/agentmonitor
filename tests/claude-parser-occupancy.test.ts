import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionMessages } from '../src/parser/claude-code.js';

// Two assistant turns with differing usage; occupancy must reflect the LAST
// turn's prompt size (input + cache_read + cache_creation), not a sum.
const jsonl = [
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-07-07T10:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-07-07T10:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
        output_tokens: 5,
      },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-07-07T10:00:02.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'more' }],
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 360_000,
        cache_creation_input_tokens: 1_800,
        output_tokens: 300,
      },
    },
  }),
].join('\n');

test('parseSessionMessages: reports last assistant turn occupancy tokens + model', () => {
  const parsed = parseSessionMessages(jsonl, 's1');
  // 2 + 360000 + 1800 = 361802 (last turn), not the earlier 150.
  assert.equal(parsed.metadata.context_used_tokens, 361_802);
  assert.equal(parsed.metadata.model, 'claude-opus-4-8');
});

test('parseSessionMessages: no usage yields undefined occupancy (not 0)', () => {
  const noUsage = JSON.stringify({
    type: 'assistant',
    sessionId: 's2',
    timestamp: '2026-07-07T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  });
  const parsed = parseSessionMessages(noUsage, 's2');
  assert.equal(parsed.metadata.context_used_tokens, undefined);
});
