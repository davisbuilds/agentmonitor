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
    // The whole point: after 2027-01-01 a Gemini Flash request bills at $1.50/MTok.
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
    // Sonnet 5 has no schedule: $2/MTok input at every date, past or future.
    assert.equal(pricingRegistry.calculate('claude-sonnet-5', ONE_M_INPUT, PROMO), 2);
    assert.equal(pricingRegistry.calculate('claude-sonnet-5', ONE_M_INPUT, REVERT), 2);
    assert.equal(pricingRegistry.calculate('claude-sonnet-5', ONE_M_INPUT), 2); // omitted date
  });

  test('an omitted date prices at the current wall-clock period', () => {
    // Guards the default path callers hit when no event timestamp is threaded.
    // Asserted against "price at now" rather than a hard-coded rate so this test
    // does not itself become a dated guard that flips on 2027-01-01 — the exact
    // fragility this feature removes.
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
    // SQLite CURRENT_TIMESTAMP writes `YYYY-MM-DD HH:MM:SS` with no zone but means
    // UTC; Node would otherwise parse it in the host TZ and misassign events near
    // a boundary. This is host-independent: the bare form must resolve to the same
    // instant as its explicit-Z equivalent regardless of where CI runs.
    assert.equal(normalizeSqliteTimestamp('2027-01-01 00:00:00'), '2027-01-01T00:00:00Z');
    assert.equal(normalizeSqliteTimestamp('2026-12-31 23:59:59.500'), '2026-12-31T23:59:59.500Z');
    // Already-zoned ISO (client_timestamp) and non-datetime strings pass through.
    assert.equal(normalizeSqliteTimestamp('2026-10-01T00:00:00Z'), '2026-10-01T00:00:00Z');
    assert.equal(normalizeSqliteTimestamp('not-a-date'), 'not-a-date');
    // The bare boundary time prices at the reverted rate — as UTC, not local.
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, '2027-01-01 00:00:00'), 1.5);
    assert.equal(pricingRegistry.calculate('gemini-3.8-flash', ONE_M_INPUT, '2026-12-31 23:59:59'), 0.75);
  });
});
