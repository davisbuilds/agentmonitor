import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionMessages } from '../src/parser/claude-code.js';

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

function assistantTurn(sessionId: string, at: string, model: string, cacheRead: number, isSidechain: boolean): string {
  return JSON.stringify({
    type: 'assistant', sessionId, isSidechain, timestamp: at,
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 1 } },
  });
}

// WHY: Older main transcripts can interleave small child turns. Those turns cannot represent the main
// thread’s occupancy.
test('parseSessionMessages: an inline sidechain turn does not overwrite the main thread occupancy', () => {
  const interleaved = [
    assistantTurn('s3', '2026-07-07T10:00:00.000Z', 'claude-opus-4-8', 500_000, false),
    assistantTurn('s3', '2026-07-07T10:00:01.000Z', 'claude-haiku-4-5-20251001', 1_200, true),
  ].join('\n');
  const parsed = parseSessionMessages(interleaved, 's3');
  assert.equal(parsed.metadata.context_used_tokens, 500_000);
  assert.equal(parsed.metadata.model, 'claude-opus-4-8');
});

// WHY: A child’s separate transcript marks all of its turns as sidechain, so dropping them there
// would erase its own occupancy.
test('parseSessionMessages: a subagent file of only sidechain turns keeps its occupancy', () => {
  const subagent = [
    assistantTurn('s4', '2026-07-07T10:00:00.000Z', 'claude-haiku-4-5-20251001', 800, true),
    assistantTurn('s4', '2026-07-07T10:00:01.000Z', 'claude-haiku-4-5-20251001', 1_200, true),
  ].join('\n');
  const parsed = parseSessionMessages(subagent, 's4');
  assert.equal(parsed.metadata.context_used_tokens, 1_200);
  assert.equal(parsed.metadata.model, 'claude-haiku-4-5-20251001');
});
