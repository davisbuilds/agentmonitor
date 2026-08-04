import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeIncompleteCostUsage } from '../frontend/src/lib/components/usage/unpriced-usage.js';

test('summarizes cache-inclusive usage for unknown-priced models', () => {
  const summary = summarizeIncompleteCostUsage([
    {
      model: 'known-model',
      pricing_status: 'known',
      cost_usd: 0.01,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 1_000,
      cache_write_tokens: 10,
      usage_events: 2,
    },
    {
      model: 'small-unknown',
      pricing_status: 'unknown',
      cost_usd: 0,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 20,
      cache_write_tokens: 2,
      usage_events: 3,
    },
    {
      model: 'cache-heavy-unknown',
      pricing_status: 'unknown',
      cost_usd: 0,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 10_000,
      cache_write_tokens: 500,
      usage_events: 7,
    },
  ]);

  assert.deepEqual(summary, {
    model_count: 2,
    unknown_pricing_model_count: 2,
    unrecalculated_model_count: 0,
    usage_events: 10,
    observed_tokens: 10_540,
    models: ['cache-heavy-unknown', 'small-unknown'],
  });
});

test('does not warn when every model has known or deprecated pricing', () => {
  assert.equal(summarizeIncompleteCostUsage([
    {
      model: 'known-model',
      pricing_status: 'known',
      cost_usd: 0.000005,
      input_tokens: 1,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usage_events: 1,
    },
    {
      model: 'deprecated-model',
      pricing_status: 'deprecated',
      cost_usd: 0.000005,
      input_tokens: 1,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usage_events: 1,
    },
  ]), null);
});

test('retains known-priced usage with zero stored cost until recalculation', () => {
  assert.deepEqual(summarizeIncompleteCostUsage([
    {
      model: 'claude-opus-5',
      pricing_status: 'known',
      cost_usd: 0,
      input_tokens: 50,
      output_tokens: 100,
      cache_read_tokens: 1_000,
      cache_write_tokens: 25,
      usage_events: 4,
    },
  ]), {
    model_count: 1,
    unknown_pricing_model_count: 0,
    unrecalculated_model_count: 1,
    usage_events: 4,
    observed_tokens: 1_175,
    models: ['claude-opus-5'],
  });
});
