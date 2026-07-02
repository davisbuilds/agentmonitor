import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel } from '../src/pricing/model-classification.js';
import { pricingRegistry } from '../src/pricing/index.js';

// Antigravity stores an internal model id (gen_metadata field 19), e.g.
// "gemini-pro-default", with a human display (field 21) like "Gemini 3.1 Pro (High)".
// We store + price the field-19 id.

test("'gemini-pro-default' resolves to the priced Gemini 3.1 Pro", () => {
  const c = classifyModel('gemini-pro-default');
  assert.equal(c.provider, 'google');
  assert.equal(c.family, 'gemini');
  assert.equal(c.tier, 'pro');
  assert.equal(c.canonical_model, 'gemini-3.1-pro-preview');
  assert.equal(c.pricing_status, 'known');
});

test('cost is computed for gemini-pro-default (non-zero, not null)', () => {
  const cost = pricingRegistry.calculate('gemini-pro-default', {
    input: 20000,
    output: 3000,
    cacheRead: 8000,
    cacheWrite: 0,
  });
  assert.ok(cost !== null && cost > 0, `expected positive cost, got ${cost}`);
});

test('display-string fallback "Gemini 3.1 Pro (High)" is priced (decoder may use field 21 when field 19 is absent)', () => {
  // When the internal id (gen_metadata field 19) is missing, the decoder falls
  // back to the field-21 display string, which is what reaches pricing. Each
  // reasoning-tier variant of the priced Pro model must still resolve to a cost.
  for (const display of ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Medium)', 'Gemini 3.1 Pro (Low)']) {
    const cost = pricingRegistry.calculate(display, { input: 20000, output: 3000, cacheRead: 8000, cacheWrite: 0 });
    assert.ok(cost !== null && cost > 0, `expected positive cost for "${display}", got ${cost}`);
  }
});

test("unmapped Antigravity flash id classifies google/gemini but stays pricing 'unknown' (honest, never zero)", () => {
  const c = classifyModel('gemini-3-flash-a');
  assert.equal(c.provider, 'google');
  assert.equal(c.family, 'gemini');
  assert.equal(c.pricing_status, 'unknown');
  // unresolved → null cost, not a silent 0
  const cost = pricingRegistry.calculate('gemini-3-flash-a', {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(cost, null);
});
