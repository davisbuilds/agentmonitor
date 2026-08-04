import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeUnpricedUsage } from '../frontend/src/lib/components/usage/unpriced-usage.js';

test('summarizes cache-inclusive usage for unknown-priced models', () => {
  const summary = summarizeUnpricedUsage([
    {
      model: 'known-model',
      pricing_status: 'known',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 1_000,
      cache_write_tokens: 10,
      usage_events: 2,
    },
    {
      model: 'small-unknown',
      pricing_status: 'unknown',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 20,
      cache_write_tokens: 2,
      usage_events: 3,
    },
    {
      model: 'cache-heavy-unknown',
      pricing_status: 'unknown',
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 10_000,
      cache_write_tokens: 500,
      usage_events: 7,
    },
  ]);

  assert.deepEqual(summary, {
    model_count: 2,
    usage_events: 10,
    observed_tokens: 10_540,
    models: ['cache-heavy-unknown', 'small-unknown'],
  });
});

test('does not warn when every model has known or deprecated pricing', () => {
  assert.equal(summarizeUnpricedUsage([
    {
      model: 'known-model',
      pricing_status: 'known',
      input_tokens: 1,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usage_events: 1,
    },
    {
      model: 'deprecated-model',
      pricing_status: 'deprecated',
      input_tokens: 1,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usage_events: 1,
    },
  ]), null);
});
