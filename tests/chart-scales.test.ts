import assert from 'node:assert/strict';
import test from 'node:test';
import {
  linearScale,
  log10Scale,
  niceLinearTicks,
  log10Ticks,
  formatUsd,
} from '../frontend/src/lib/components/ui/chart/scales.ts';

test('linearScale maps domain endpoints and midpoint into the range', () => {
  const s = linearScale([0, 10], [0, 100]);
  assert.equal(s(0), 0);
  assert.equal(s(10), 100);
  assert.equal(s(5), 50);
  assert.equal(s(2.5), 25);
});

test('linearScale supports an inverted range (SVG y grows downward)', () => {
  const y = linearScale([0, 1], [100, 0]);
  assert.equal(y(0), 100); // score 0 at the bottom
  assert.equal(y(1), 0); // score 1 at the top
  assert.equal(y(0.25), 75);
});

test('linearScale collapses a zero-width domain to the range start (no NaN)', () => {
  const s = linearScale([5, 5], [0, 100]);
  assert.equal(s(5), 0);
  assert.equal(s(9), 0);
  assert.ok(!Number.isNaN(s(1)));
});

test('log10Scale places decade endpoints and the geometric midpoint', () => {
  const s = log10Scale([0.01, 1], [0, 100]);
  assert.equal(s(0.01), 0);
  assert.equal(s(1), 100);
  assert.ok(Math.abs(s(0.1) - 50) < 1e-9); // geometric middle of two decades
});

test('log10Scale clamps non-positive values to the domain floor', () => {
  const s = log10Scale([0.01, 1], [0, 100]);
  assert.equal(s(0), 0);
  assert.equal(s(-3), 0);
});

test('niceLinearTicks produces round covering ticks without float drift', () => {
  // 1-2-5 nice-numbering picks a 0.2 step for [0,1] (0.25 is not a nice step).
  const ticks = niceLinearTicks(0, 1, 5);
  assert.deepEqual(ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  // No 0.30000000000000004-style drift.
  assert.ok(ticks.every((t) => t === Number(t.toFixed(2))));
});

test('niceLinearTicks brackets a non-trivial range', () => {
  const ticks = niceLinearTicks(3, 17, 5);
  assert.equal(ticks[0] <= 3, true);
  assert.equal(ticks[ticks.length - 1] >= 17, true);
});

test('niceLinearTicks returns a single tick for a degenerate range', () => {
  assert.deepEqual(niceLinearTicks(4, 4), [4]);
});

test('log10Ticks returns bracketing decade ticks', () => {
  assert.deepEqual(log10Ticks(0.022, 1.1), [0.01, 0.1, 1, 10]);
  assert.deepEqual(log10Ticks(0.05, 0.5), [0.01, 0.1, 1]);
});

test('log10Ticks rejects non-positive bounds', () => {
  assert.deepEqual(log10Ticks(0, 1), []);
  assert.deepEqual(log10Ticks(-1, 1), []);
});

test('formatUsd renders compact axis labels', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.01), '$0.01');
  assert.equal(formatUsd(0.05), '$0.05');
  assert.equal(formatUsd(0.5), '$0.5');
  assert.equal(formatUsd(1), '$1');
  assert.equal(formatUsd(1.1), '$1.1');
  assert.equal(formatUsd(120), '$120');
});

test('niceLinearTicks picks the 1-2-5 step for the range, not just any covering set', () => {
  // [3, 17]: rough step 14/4 rounds to 5, so ticks start/end on multiples of 5.
  assert.deepEqual(niceLinearTicks(3, 17, 5), [0, 5, 10, 15, 20]);
  // [0, 100] with 5 ticks: 25 is not nice, 20 is.
  assert.deepEqual(niceLinearTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  // Fewer requested ticks widen the step.
  assert.deepEqual(niceLinearTicks(0, 100, 3), [0, 50, 100]);
  // Two ticks means one interval: the whole range is a single step.
  assert.deepEqual(niceLinearTicks(0, 10, 2), [0, 10]);
});

test('niceLinearTicks treats an inverted range as degenerate rather than looping', () => {
  assert.deepEqual(niceLinearTicks(10, 2), [10]);
});

test('log10Scale collapses a zero-width domain to the range start (no NaN)', () => {
  const s = log10Scale([1, 1], [0, 100]);
  assert.equal(s(1), 0);
  assert.equal(s(50), 0);
});

test('log10Scale honours an inverted range', () => {
  const s = log10Scale([0.01, 1], [100, 0]);
  assert.equal(s(0.01), 100);
  assert.equal(s(1), 0);
});

test('log10Ticks on exact decades does not add an extra decade', () => {
  assert.deepEqual(log10Ticks(0.01, 10), [0.01, 0.1, 1, 10]);
  assert.deepEqual(log10Ticks(1, 1), [1]);
});

test('formatUsd switches precision at the $1 and $100 boundaries', () => {
  assert.equal(formatUsd(0.123), '$0.12'); // two significant figures below $1
  assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatUsd(99.5), '$99.5');
  assert.equal(formatUsd(100), '$100');
  assert.equal(formatUsd(1234.56), '$1235'); // whole dollars from $100 up
});
