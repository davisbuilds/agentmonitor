import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel } from '../src/pricing/model-classification.js';
import { pricingRegistry } from '../src/pricing/index.js';

// WHY: The provider stores both an internal model identity and a friendly name. Include both so
// charging the display name instead cannot pass unnoticed.

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
  for (const display of ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Medium)', 'Gemini 3.1 Pro (Low)']) {
    const cost = pricingRegistry.calculate(display, { input: 20000, output: 3000, cacheRead: 8000, cacheWrite: 0 });
    assert.ok(cost !== null && cost > 0, `expected positive cost for "${display}", got ${cost}`);
  }
});

test("Antigravity flash id 'gemini-3-flash-a' now resolves to priced Gemini 3.5 Flash", () => {
  const c = classifyModel('gemini-3-flash-a');
  assert.equal(c.provider, 'google');
  assert.equal(c.family, 'gemini');
  assert.equal(c.tier, 'flash');
  assert.equal(c.canonical_model, 'gemini-3.5-flash');
  assert.equal(c.pricing_status, 'known');
  const cost = pricingRegistry.calculate('gemini-3-flash-a', {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.ok(cost !== null && cost > 0, `expected positive cost, got ${cost}`);
});

test('a genuinely-unknown model still resolves to null cost, not a silent zero (honesty invariant)', () => {
  const c = classifyModel('gemini-99-imaginary');
  assert.equal(c.provider, 'google');
  assert.equal(c.pricing_status, 'unknown');
  assert.equal(pricingRegistry.calculate('gemini-99-imaginary', { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
});

test('Antigravity Gemini 4 ids and display strings resolve and price', () => {
  for (const id of [
    'gemini-4-neon',
    'gemini-4-neon-xhigh',
    'gemini-4-neon-high',
    'gemini-4-neon-medium',
    'gemini-4-neon-low',
    'Gemini 4 Neon (XHigh)',
    'Gemini 4 Neon (High)',
  ]) {
    const c = classifyModel(id);
    assert.equal(c.provider, 'google', id);
    assert.equal(c.family, 'gemini', id);
    assert.equal(c.tier, 'neon', id);
    assert.equal(c.canonical_model, 'gemini-4-neon', id);
    assert.equal(c.pricing_status, 'known', id);
    const cost = pricingRegistry.calculate(id, { input: 100_000, output: 10_000, cacheRead: 50_000, cacheWrite: 0 });
    assert.ok(cost !== null && Math.abs(cost - (0.3 + 0.15 + 0.0075)) < 1e-9, `${id} got ${cost}`);
  }

  for (const id of [
    'gemini-4-hydrogen-tiered-xhigh',
    'gemini-4-hydrogen-xhigh',
    'gemini-4-hydrogen-high',
    'Gemini 4 Hydrogen (XHigh)',
  ]) {
    const c = classifyModel(id);
    assert.equal(c.provider, 'google', id);
    assert.equal(c.family, 'gemini', id);
    assert.equal(c.tier, 'hydrogen', id);
    assert.equal(c.canonical_model, 'gemini-4-hydrogen', id);
    assert.equal(c.pricing_status, 'known', id);
    const cost = pricingRegistry.calculate(id, { input: 100_000, output: 10_000, cacheRead: 50_000, cacheWrite: 0 });
    assert.ok(cost !== null && Math.abs(cost - (0.15 + 0.075 + 0.00375)) < 1e-9, `${id} got ${cost}`);
  }

  for (const [id, canonical, tier] of [
    ['gemini-4-carbon-high', 'gemini-4-carbon', 'carbon'],
    ['Gemini 4 Carbon (High)', 'gemini-4-carbon', 'carbon'],
    ['gemini-4-argon-medium', 'gemini-4-argon', 'argon'],
    ['Gemini 4 Argon (Medium)', 'gemini-4-argon', 'argon'],
  ] as const) {
    const c = classifyModel(id);
    assert.equal(c.provider, 'google', id);
    assert.equal(c.family, 'gemini', id);
    assert.equal(c.tier, tier, id);
    assert.equal(c.canonical_model, canonical, id);
    assert.equal(c.pricing_status, 'known', id);
    const promo = pricingRegistry.calculate(id, { input: 100_000, output: 10_000, cacheRead: 50_000, cacheWrite: 0 }, '2026-11-25T12:00:00Z');
    assert.ok(promo !== null && Math.abs(promo - (0.2 + 0.1 + 0.005)) < 1e-9, `${id} got ${promo}`);
  }
});
