import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { pricingRegistry } from '../src/pricing/index.js';

/**
 * Pricing that expires on a date nobody is watching.
 *
 * The engine has no date-awareness: `claude.json` holds one set of rates and uses
 * them forever. Anthropic's Sonnet 5 introductory rates end on 2026-08-31, and
 * nothing in the system knows that — the day they lapse, every Sonnet 5 event is
 * billed ~33% light and the dashboard goes on looking entirely reasonable.
 *
 * That is the same shape as the bug that shipped stale pricing tables to dist/ for
 * five months: money quietly wrong, no error anywhere, discovered only by noticing
 * a number looked off. So it gets a deadline instead of a memory. This test tracks
 * the intro rates while they are correct and fails the build the moment they are
 * not, with the replacement rates in the message.
 *
 * When it fires: update the four rates in src/pricing/data/claude.json, then move
 * the expectation below from INTRO to STANDARD. Costs already written at intro
 * rates stay as billed — they were correct when recorded.
 */

const INTRO_ENDS = Date.parse('2026-09-01T00:00:00Z');

const INTRO = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const STANDARD = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe('pricing: dated rates', () => {
  test('claude-sonnet-5 rates match the period we are actually in', () => {
    const pricing = pricingRegistry.lookup('claude-sonnet-5');
    assert.ok(pricing, 'claude-sonnet-5 is missing from the pricing registry');

    const introActive = Date.now() < INTRO_ENDS;
    const expected = introActive ? INTRO : STANDARD;

    // Read back through the registry, not the JSON: this is the path that actually
    // prices an event, and it stores per-token rates. Rounding absorbs the float
    // noise of the per-MTok round trip.
    const perMTok = (perToken: number) => Math.round(perToken * 1e6 * 1000) / 1000;
    const actual = {
      input: perMTok(pricing.inputCostPerToken),
      output: perMTok(pricing.outputCostPerToken),
      cacheRead: perMTok(pricing.cacheReadCostPerToken),
      cacheWrite: perMTok(pricing.cacheWriteCostPerToken),
    };

    assert.deepEqual(
      actual,
      expected,
      introActive
        ? 'claude-sonnet-5 no longer carries the introductory rates this test expects. '
          + 'If the intro period ended early, update INTRO_ENDS.'
        : 'Claude Sonnet 5 introductory pricing expired on 2026-08-31 and the registry '
          + 'still bills at intro rates, so every Sonnet 5 event is under-costed. '
          + `Set inputCostPerMTok=${STANDARD.input}, outputCostPerMTok=${STANDARD.output}, `
          + `cacheReadCostPerMTok=${STANDARD.cacheRead}, cacheWriteCostPerMTok=${STANDARD.cacheWrite} `
          + 'in src/pricing/data/claude.json, then flip this test to STANDARD.',
    );
  });
});
