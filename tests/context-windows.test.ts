import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveContextWindow,
  computeOccupancy,
  computeSessionOccupancy,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
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
  assert.equal(resolveContextWindow({ agent: 'codex' }), CODEX_DEFAULT_CONTEXT_WINDOW);
  assert.equal(CODEX_DEFAULT_CONTEXT_WINDOW, 256_000);
  assert.equal(
    resolveContextWindow({ agent: 'codex', codexDefaultWindow: 400_000 }),
    400_000,
  );
});

test('resolveContextWindow: over-window guard bumps to the next tier, never below observed', () => {
  const window = resolveContextWindow({
    agent: 'claude_code',
    observedTokens: 1_200_000,
  });
  assert.ok(window !== null && window >= 1_200_000, `expected >= observed, got ${window}`);
});

test('resolveContextWindow: Antigravity defaults to 1 MiB (1,048,576) and honors observedTokens without jumping past 1 MiB prematurely', () => {
  assert.equal(ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW, 1_048_576);
  assert.equal(resolveContextWindow({ agent: 'antigravity' }), ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow({ agent: 'antigravity', observedTokens: 1_000_001 }), 1_048_576);
  assert.equal(resolveContextWindow({ agent: 'antigravity', observedTokens: 1_048_576 }), 1_048_576);
  assert.equal(resolveContextWindow({ agent: 'antigravity', observedTokens: 1_050_000 }), 2_000_000);
  assert.equal(resolveContextWindow({ agent: 'antigravity', reportedWindow: 200_000, observedTokens: 50_000 }), 200_000);
});

test('resolveContextWindow: unknown agent is unavailable (null), not a wrong default', () => {
  assert.equal(resolveContextWindow({ agent: 'unknown_agent' }), null);
});

test('computeOccupancy: percent is rounded and capped at 100', () => {
  assert.deepEqual(
    computeOccupancy({ usedTokens: 500_000, window: 1_000_000 }),
    { used: 500_000, window: 1_000_000, pct: 50 },
  );
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
