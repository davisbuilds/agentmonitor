import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelId } from '../src/pricing/index.ts';
import { formatModelName } from '../frontend/src/lib/format.ts';

// The app shows a model the way pricing spells it, minus a release date stamp.
// The two live in separate bundles, so this keeps their rules from drifting.
test('the displayed model name follows the server\'s model ID normalization', () => {
  const ids = [
    'claude-opus-4-8',
    'anthropic/claude-opus-4-8',
    'openai/gpt-6-astra',
    'google/gemini-3.8-flash',
    'claude-opus-5-5[1m]',
    'claude-opus-5-5[1M]',
    'us.anthropic.claude-opus-4-8-v1:0',
    'global.anthropic.claude-sonnet-5-v1',
    'anthropic.claude-haiku-5-5-v2:1',
    '  gpt-5.6-sol  ',
    'gemini-3.1-pro-preview',
  ];
  for (const id of ids) {
    assert.equal(formatModelName(id), normalizeModelId(id), id);
  }
  assert.equal(formatModelName('claude-haiku-4-5-20251001'), normalizeModelId('claude-haiku-4-5'));
});
