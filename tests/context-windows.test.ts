import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveContextWindow,
  computeOccupancy,
  computeSessionOccupancy,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
} from '../src/pricing/context-windows.js';

test('resolveContextWindow: Claude defaults to 1M', () => {
  assert.equal(
    resolveContextWindow({ agent: 'claude_code', model: 'claude-opus-4-8' }),
    CLAUDE_DEFAULT_CONTEXT_WINDOW,
  );
  assert.equal(CLAUDE_DEFAULT_CONTEXT_WINDOW, 1_000_000);
});

test('resolveContextWindow: Codex uses reported window when present', () => {
  assert.equal(
    resolveContextWindow({ agent: 'codex', reportedWindow: 272_000 }),
    272_000,
  );
});

test('resolveContextWindow: Codex falls back to configurable default', () => {
  // module default
  assert.equal(resolveContextWindow({ agent: 'codex' }), CODEX_DEFAULT_CONTEXT_WINDOW);
  assert.equal(CODEX_DEFAULT_CONTEXT_WINDOW, 256_000);
  // caller-supplied override
  assert.equal(
    resolveContextWindow({ agent: 'codex', codexDefaultWindow: 400_000 }),
    400_000,
  );
});

test('resolveContextWindow: over-window guard bumps to the next tier, never below observed', () => {
  // A Claude session observed above the 1M default must not yield a denominator
  // smaller than what was observed (which would render >100%).
  const window = resolveContextWindow({
    agent: 'claude_code',
    observedTokens: 1_200_000,
  });
  assert.ok(window !== null && window >= 1_200_000, `expected >= observed, got ${window}`);
});

test('resolveContextWindow: unknown agent is unavailable (null), not a wrong default', () => {
  assert.equal(resolveContextWindow({ agent: 'antigravity' }), null);
});

test('computeOccupancy: percent is rounded and capped at 100', () => {
  assert.deepEqual(
    computeOccupancy({ usedTokens: 500_000, window: 1_000_000 }),
    { used: 500_000, window: 1_000_000, pct: 50 },
  );
  // cap
  assert.equal(computeOccupancy({ usedTokens: 2_000_000, window: 1_000_000 })?.pct, 100);
});

test('computeOccupancy: missing or invalid inputs are unavailable (null)', () => {
  assert.equal(computeOccupancy({ usedTokens: null, window: 1_000_000 }), null);
  assert.equal(computeOccupancy({ usedTokens: 100, window: 0 }), null);
  assert.equal(computeOccupancy({ usedTokens: 100, window: null }), null);
});

test('computeSessionOccupancy: end-to-end Codex with reported window', () => {
  assert.deepEqual(
    computeSessionOccupancy({
      agent: 'codex',
      usedTokens: 64_000,
      reportedWindow: 256_000,
    }),
    { used: 64_000, window: 256_000, pct: 25 },
  );
});

test('computeSessionOccupancy: no usable numerator yet is unavailable (null)', () => {
  assert.equal(computeSessionOccupancy({ agent: 'claude_code', usedTokens: null }), null);
});
