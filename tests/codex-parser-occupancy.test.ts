import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexSessionMessages } from '../src/parser/codex-sessions.js';

// Two token_count events; occupancy must reflect the LAST last_token_usage
// input (cache-inclusive) and reported model_context_window — never
// total_token_usage (cumulative billing).
const jsonl = [
  JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-07-07T10:00:00.000Z',
    payload: { id: 's1', cwd: '/tmp/proj', timestamp: '2026-07-07T10:00:00.000Z' },
  }),
  JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-07T10:00:01.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 20, total_tokens: 1_020 },
        total_token_usage: { input_tokens: 5_000, total_tokens: 5_100 },
        model_context_window: 258_400,
      },
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-07T10:00:02.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 64_000, cached_input_tokens: 60_000, output_tokens: 300, total_tokens: 64_300 },
        total_token_usage: { input_tokens: 200_000, total_tokens: 260_000 },
        model_context_window: 258_400,
      },
    },
  }),
].join('\n');

test('parseCodexSessionMessages: reports last request occupancy + reported window', () => {
  const parsed = parseCodexSessionMessages(jsonl, 's1');
  assert.equal(parsed.metadata.context_used_tokens, 64_000); // last input, not total
  assert.equal(parsed.metadata.context_window_reported, 258_400);
});

test('parseCodexSessionMessages: no token_count yields undefined occupancy', () => {
  const noTokens = JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-07-07T10:00:00.000Z',
    payload: { id: 's2', cwd: '/tmp/p', timestamp: '2026-07-07T10:00:00.000Z' },
  });
  const parsed = parseCodexSessionMessages(noTokens, 's2');
  assert.equal(parsed.metadata.context_used_tokens, undefined);
  assert.equal(parsed.metadata.context_window_reported, undefined);
});
