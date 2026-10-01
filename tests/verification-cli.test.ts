import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUsage, usageExpected, scenarioById } from '../scripts/verify/contracts.js';

test('usage oracle rejects a believable missing event, wrong cost, and malformed result', () => {
  assertUsage({ ...usageExpected.all }, usageExpected.all);
  assert.throws(() => assertUsage({ ...usageExpected.all, total_usage_events: 999 }, usageExpected.all));
  assert.throws(() => assertUsage({ ...usageExpected.all, total_cost_usd: 0 }, usageExpected.all));
  assert.throws(() => assertUsage({}, usageExpected.all));
});

test('discovery rejects unsupported scenarios', () => {
  assert.equal(scenarioById('usage').fixture, 'usage-1000-v1');
  assert.throws(() => scenarioById('all'));
});
