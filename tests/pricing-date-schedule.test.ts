import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { pricingRegistry, normalizeSqliteTimestamp } from '../src/pricing/index.js';

/**
 * Date-aware pricing (rate schedules).
 *
 * A model may carry a `schedule` of `{ from, ...rates }` periods on top of its
 * inline base rates. `calculate()` / `effectiveRates()` take an optional `at`
 * timestamp and select the period effective at that instant, so an event is
 * priced by the rate that was in force when it happened — not by whatever the
 * table says today.
 *
 * The live fixture is the Gemini 3.x Flash launch promo: base $0.75 in / $3.75
 * out, reverting to list $1.50 / $7.50 (cacheRead $0.15) on 2027-01-01. One
 * exact million input tokens makes the per-MTok rate readable straight off the
 * returned cost.
 */
const ONE_M_INPUT = { input: 1_000_000, output: 0 } as const;
const PROMO = '2026-10-01T00:00:00Z';
const REVERT = '2027-06-01T00:00:00Z';
const BOUNDARY = '2027-01-01T00:00:00Z';

describe('pricing: date-aware rate schedules', () => {
  test('a scheduled model is priced at the promo rate before the revert date', () => {
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, PROMO), 0.75);
  });

  test('a scheduled model is priced at the reverted rate after the revert date', () => {
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, REVERT), 1.5);
  });

  test('the `from` boundary is inclusive — the new rate applies at the instant it starts', () => {
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, BOUNDARY), 1.5);
  });

  test('one millisecond before the boundary is still the promo rate', () => {
    const justBefore = Date.parse(BOUNDARY) - 1;
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, justBefore), 0.75);
  });

  test('all three promo Flash tiers carry the same revert schedule', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) {
      assert.equal(pricingRegistry.calculate(model, ONE_M_INPUT, PROMO), 0.75, `${model} promo`);
      assert.equal(pricingRegistry.calculate(model, ONE_M_INPUT, REVERT), 1.5, `${model} reverted`);
    }
  });

  test('the scheduled cache-read rate moves with the base rate across the boundary', () => {
    const cacheRead = { input: 0, output: 0, cacheRead: 1_000_000 } as const;
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', cacheRead, PROMO), 0.075);
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', cacheRead, REVERT), 0.15);
  });

  test('effectiveRates honors the schedule so cache-savings math uses the in-force rate', () => {
    const before = pricingRegistry.effectiveRates('gemini-3.8-flash', ONE_M_INPUT, PROMO);
    const after = pricingRegistry.effectiveRates('gemini-3.8-flash', ONE_M_INPUT, REVERT);
    assert.ok(before && after);
    assert.equal(Math.round(before.inputCostPerToken * 1e6 * 1000) / 1000, 0.75);
    assert.equal(Math.round(after.inputCostPerToken * 1e6 * 1000) / 1000, 1.5);
  });

  test('a model with no schedule is unaffected by the `at` date', () => {
    assert.equal(pricingRegistry.calculate('claude-sonnet-5', ONE_M_INPUT, PROMO), 2);
    assert.equal(pricingRegistry.calculate('claude-sonnet-5', ONE_M_INPUT, REVERT), 2);
    assert.equal(pricingRegistry.calculate('claude-sonnet-5', ONE_M_INPUT), 2);
  });

  test('an omitted date prices at the current wall-clock period', () => {
    // WHY: A fixed expected rate for the implicit timestamp would break when the schedule crosses
    // another date.
    const omitted = pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT);
    const explicitNow = pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, Date.now());
    assert.equal(omitted, explicitNow);
  });

  test('an unparseable timestamp does not crash — it falls back to the current period', () => {
    const junk = pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, 'not-a-date');
    const explicitNow = pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, Date.now());
    assert.equal(junk, explicitNow);
  });

  test('a zone-less SQLite created_at is read as UTC, not host-local time', () => {
    // WHY: SQLite’s timezone-free timestamp denotes UTC, while Node can interpret its bare form in
    // the host zone.
    assert.equal(normalizeSqliteTimestamp('2027-01-01 00:00:00'), '2027-01-01T00:00:00Z');
    assert.equal(normalizeSqliteTimestamp('2026-12-31 23:59:59.500'), '2026-12-31T23:59:59.500Z');
    assert.equal(normalizeSqliteTimestamp('2026-10-01T00:00:00Z'), '2026-10-01T00:00:00Z');
    assert.equal(normalizeSqliteTimestamp('not-a-date'), 'not-a-date');
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, '2027-01-01 00:00:00'), 1.5);
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, '2026-12-31 23:59:59'), 0.75);
  });

  test('gemini-4-carbon and gemini-4-argon move from launch promo ($2/$10/$0.10) to list ($4/$20/$0.20) on 2026-12-01', () => {
    const g4Boundary = '2026-12-01T00:00:00Z';
    const g4Before = Date.parse(g4Boundary) - 1;
    const g4After = '2026-12-15T00:00:00Z';
    const tokens = { input: 500_000, output: 100_000, cacheRead: 200_000, cacheWrite: 50_000 };
    const promoExpected = 0.5 * 2 + 0.1 * 10 + 0.2 * 0.1;
    const listExpected = 0.5 * 4 + 0.1 * 20 + 0.2 * 0.2;

    for (const model of ['gemini-4-carbon', 'gemini-4-argon']) {
      const promoCost = pricingRegistry.calculate(model, tokens, '2026-11-24T00:00:00Z');
      const justBeforeCost = pricingRegistry.calculate(model, tokens, g4Before);
      const atBoundaryCost = pricingRegistry.calculate(model, tokens, g4Boundary);
      const afterCost = pricingRegistry.calculate(model, tokens, g4After);
      const sqliteBefore = pricingRegistry.calculate(model, tokens, '2026-11-30 23:59:59');
      const sqliteAt = pricingRegistry.calculate(model, tokens, '2026-12-01 00:00:00');

      assert.ok(promoCost !== null && Math.abs(promoCost - promoExpected) < 1e-9, `${model} promo`);
      assert.ok(justBeforeCost !== null && Math.abs(justBeforeCost - promoExpected) < 1e-9, `${model} 1ms before`);
      assert.ok(sqliteBefore !== null && Math.abs(sqliteBefore - promoExpected) < 1e-9, `${model} sqlite before`);
      assert.ok(atBoundaryCost !== null && Math.abs(atBoundaryCost - listExpected) < 1e-9, `${model} boundary`);
      assert.ok(afterCost !== null && Math.abs(afterCost - listExpected) < 1e-9, `${model} after`);
      assert.ok(sqliteAt !== null && Math.abs(sqliteAt - listExpected) < 1e-9, `${model} sqlite at`);

      const promoRates = pricingRegistry.effectiveRates(model, tokens, g4Before);
      const listRates = pricingRegistry.effectiveRates(model, tokens, g4Boundary);
      assert.ok(promoRates && listRates, `${model} effectiveRates`);
      assert.equal(promoRates.inputCostPerToken, 2 / 1_000_000, `${model} promo input`);
      assert.equal(promoRates.outputCostPerToken, 10 / 1_000_000, `${model} promo output`);
      assert.equal(promoRates.cacheReadCostPerToken, 0.1 / 1_000_000, `${model} promo cacheRead`);
      assert.equal(listRates.inputCostPerToken, 4 / 1_000_000, `${model} list input`);
      assert.equal(listRates.outputCostPerToken, 20 / 1_000_000, `${model} list output`);
      assert.equal(listRates.cacheReadCostPerToken, 0.2 / 1_000_000, `${model} list cacheRead`);
    }
  });
});
