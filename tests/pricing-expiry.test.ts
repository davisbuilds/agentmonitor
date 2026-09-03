import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { pricingRegistry } from '../src/pricing/index.js';

/**
 * Claude Sonnet 5 rate guard.
 *
 * Sonnet 5 launched at $2/$10 per MTok, billed as "introductory pricing through
 * 2026-08-31" with a scheduled rise to $3/$15 on 2026-09-01. Anthropic then
 * CANCELLED that increase: per the pricing docs, the $2/$10 rate "is now the
 * standard price" and "the previously scheduled increase ... will not occur."
 *
 * This originally tracked the intro→standard deadline. It caught a real bug the
 * wrong way round: an agent, trusting the old schedule, bumped the table to
 * $3/$15 on 2026-09-01 (commit ed1bf70) — a silent 50% OVER-charge on the
 * default coding model — before a live-page audit found the increase was
 * cancelled. So the date logic is gone; this is now a plain assertion that
 * Sonnet 5 sits at its permanent $2/$10, guarding against a re-"correction".
 * Verified against https://platform.claude.com/docs/en/about-claude/pricing
 * (2026-09-03). If Anthropic ever does raise it, update both this and
 * src/pricing/data/claude.json together.
 */
describe('pricing: Claude Sonnet 5 permanent rate', () => {
  test('claude-sonnet-5 stays at $2/$10 (cacheRead $0.20, 5m write $2.50)', () => {
    const pricing = pricingRegistry.lookup('claude-sonnet-5');
    assert.ok(pricing, 'claude-sonnet-5 is missing from the pricing registry');

    // Read back through the registry, not the JSON: this is the path that prices
    // an event, and it stores per-token rates. Rounding absorbs the per-MTok
    // round-trip float noise.
    const perMTok = (perToken: number) => Math.round(perToken * 1e6 * 1000) / 1000;
    assert.deepEqual(
      {
        input: perMTok(pricing.inputCostPerToken),
        output: perMTok(pricing.outputCostPerToken),
        cacheRead: perMTok(pricing.cacheReadCostPerToken),
        cacheWrite: perMTok(pricing.cacheWriteCostPerToken),
      },
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      'Claude Sonnet 5 must stay at its permanent $2/$10 rate. The launch '
        + 'introductory rate was made permanent — the scheduled rise to $3/$15 was '
        + 'cancelled — so do NOT "restore" $3/$15. If Anthropic actually changes it, '
        + 'update src/pricing/data/claude.json and this expectation together.',
    );
  });
});
