import assert from 'node:assert/strict';
import test from 'node:test';
import type { BenchmarkArm } from '../frontend/src/lib/api/client.ts';
import {
  computeFrontier,
  isPlottable,
} from '../frontend/src/lib/components/benchmarks/frontier-geometry.ts';

// Fixture mirrors the real `am-consistency-pareto-2026-08-29` study so the
// frontier geometry is validated against a known Pareto front:
//   frontier (cost asc): glm → deepseek → luna
//   dominated: terra → luna, minimax → deepseek
//   unpriced (off cost-axis): nemotron, laguna
function arm(p: Partial<BenchmarkArm> & Pick<BenchmarkArm, 'canonical_model' | 'label' | 'mean_score' | 'cost_per_trial' | 'pareto' | 'dominated_by'>): BenchmarkArm {
  return {
    reasoning_effort: null,
    n: 3,
    cost_basis: 'derived',
    mean_t_agent_s: 0,
    cache_reads: 0,
    native: false,
    verdict: 'dominated',
    excluded_trials: 0,
    noop_trials: 0,
    token_basis: null,
    usage_evidence_grade: null,
    ranking_eligible: null,
    ranking_exclusion_reason: null,
    ...p,
  } as BenchmarkArm;
}

const FIXTURE: BenchmarkArm[] = [
  arm({ canonical_model: 'gpt-5.6-luna', label: 'gpt-5.6-luna (max)', mean_score: 1, cost_per_trial: 0.479, pareto: true, dominated_by: null, native: true }),
  arm({ canonical_model: 'gpt-5.6-terra', label: 'gpt-5.6-terra (xhigh)', mean_score: 1, cost_per_trial: 1.108, pareto: false, dominated_by: 'gpt-5.6-luna', native: true }),
  arm({ canonical_model: 'deepseek-v4-flash-0731', label: 'deepseek-v4-flash-0731', mean_score: 0.778, cost_per_trial: 0.050, pareto: true, dominated_by: null }),
  arm({ canonical_model: 'minimax-m3', label: 'minimax-m3', mean_score: 0.444, cost_per_trial: 0.511, pareto: false, dominated_by: 'deepseek-v4-flash-0731' }),
  arm({ canonical_model: 'nemotron-3-ultra', label: 'nemotron-3-ultra', mean_score: 0.444, cost_per_trial: null, pareto: false, dominated_by: null }),
  arm({ canonical_model: 'glm-5.3-flash', label: 'glm-5.3-flash', mean_score: 0.222, cost_per_trial: 0.022, pareto: true, dominated_by: null }),
  arm({ canonical_model: 'laguna-s-2.1', label: 'laguna-s-2.1', mean_score: 0, cost_per_trial: null, pareto: false, dominated_by: null }),
];

const RANGES = { xRange: [0, 100] as const, yRange: [100, 0] as const };

test('isPlottable admits any priced arm including a free $0, but not a null cost', () => {
  assert.equal(isPlottable(FIXTURE[0]), true); // luna, $0.479
  assert.equal(isPlottable(FIXTURE[4]), false); // nemotron, null → off-axis
  // A genuinely free route is priced ($0) and belongs on the axis (left edge).
  assert.equal(isPlottable(arm({ canonical_model: 'x', label: 'x', mean_score: 1, cost_per_trial: 0, pareto: false, dominated_by: null })), true);
});

test('unpriced arms are held off the cost axis, not dropped', () => {
  const g = computeFrontier(FIXTURE, RANGES);
  assert.equal(g.points.length, 5);
  assert.deepEqual(g.unpriced.map((a) => a.label).sort(), ['laguna-s-2.1', 'nemotron-3-ultra']);
});

test('frontier polyline is the pareto subset ordered by cost ascending', () => {
  const g = computeFrontier(FIXTURE, RANGES);
  assert.deepEqual(
    g.frontier.map((p) => p.arm.label),
    ['glm-5.3-flash', 'deepseek-v4-flash-0731', 'gpt-5.6-luna (max)'],
  );
});

test('domination connectors link dominated arms to their dominator by canonical_model', () => {
  const g = computeFrontier(FIXTURE, RANGES);
  const pairs = g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]).sort();
  assert.deepEqual(pairs, [
    ['gpt-5.6-terra (xhigh)', 'gpt-5.6-luna (max)'],
    ['minimax-m3', 'deepseek-v4-flash-0731'],
  ]);
});

test('x grows with cost and y is inverted (score 1 at the top)', () => {
  const g = computeFrontier(FIXTURE, RANGES);
  const byLabel = new Map(g.points.map((p) => [p.arm.label, p]));
  const glm = byLabel.get('glm-5.3-flash')!;
  const terra = byLabel.get('gpt-5.6-terra (xhigh)')!;
  const luna = byLabel.get('gpt-5.6-luna (max)')!;
  assert.ok(glm.x < luna.x && luna.x < terra.x); // cheapest → priciest
  assert.ok(luna.y < glm.y); // score 1 sits above score 0.22 (smaller y = higher)
  assert.equal(luna.y, 0); // score 1 pins to the top of the inverted range
});

test('cost axis brackets to whole decades so ticks land on the plot edges', () => {
  const g = computeFrontier(FIXTURE, RANGES);
  assert.deepEqual(g.costDomain, [0.01, 10]); // min 0.022 → 0.01, max 1.108 → 10
});

test('a free ($0) arm is plotted at the left edge, not treated as unpriced', () => {
  const g = computeFrontier(
    [
      arm({ canonical_model: 'free-model', label: 'free-model', mean_score: 0.9, cost_per_trial: 0, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'paid', label: 'paid', mean_score: 0.9, cost_per_trial: 0.5, pareto: false, dominated_by: 'free-model' }),
    ],
    RANGES,
  );
  assert.equal(g.points.length, 2); // both priced
  assert.deepEqual(g.free.map((a) => a.label), ['free-model']);
  assert.deepEqual(g.unpriced, []); // $0 is not "unpriced"
  const freePt = g.points.find((p) => p.arm.label === 'free-model')!;
  assert.equal(freePt.x, RANGES.xRange[0]); // pinned to the left edge
  assert.ok(g.frontier.some((p) => p.arm.label === 'free-model')); // still on the front
  // The free arm dominates the paid one and gets the connector.
  assert.deepEqual(
    g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]),
    [['paid', 'free-model']],
  );
});

test('connector links to the effort that actually dominates, not the first frontier match', () => {
  // Two efforts share canonical_model 'm'; the expensive high-score effort is
  // listed first. x is dominated by the cheap low-score effort only. The
  // connector must reach m(low), not the first frontier candidate m(high).
  const g = computeFrontier(
    [
      arm({ canonical_model: 'm', label: 'm (high)', reasoning_effort: 'high', mean_score: 1.0, cost_per_trial: 0.5, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'm', label: 'm (low)', reasoning_effort: 'low', mean_score: 0.5, cost_per_trial: 0.02, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'x', label: 'x', mean_score: 0.4, cost_per_trial: 0.1, pareto: false, dominated_by: 'm' }),
    ],
    RANGES,
  );
  assert.deepEqual(
    g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]),
    [['x', 'm (low)']],
  );
});

test('a single priced arm is bracketed to its enclosing decade, not collapsed', () => {
  const g = computeFrontier([FIXTURE[0]], RANGES); // luna, $0.479
  assert.deepEqual(g.costDomain, [0.1, 1]);
  assert.equal(g.points.length, 1);
  assert.ok(g.points[0].x > 0 && g.points[0].x < 100); // lands mid-axis
});

test('a single arm on an exact decade is widened a decade each side, not collapsed to a zero-width axis', () => {
  // floor(log10(1)) === ceil(log10(1)): without the widening the domain is
  // [1, 1], the log scale degenerates, and every point stacks on the left edge.
  const g = computeFrontier(
    [arm({ canonical_model: 'one', label: 'one', mean_score: 0.5, cost_per_trial: 1, pareto: true, dominated_by: null })],
    RANGES,
  );
  assert.deepEqual(g.costDomain, [0.1, 10]);
  assert.ok(Math.abs(g.points[0].x - 50) < 1e-9); // geometric centre of [0.1, 10]
});

test('several arms sharing one exact-decade cost are also widened and centred', () => {
  const g = computeFrontier(
    [
      arm({ canonical_model: 'a', label: 'a', mean_score: 0.9, cost_per_trial: 0.1, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'b', label: 'b', mean_score: 0.3, cost_per_trial: 0.1, pareto: false, dominated_by: 'a' }),
    ],
    RANGES,
  );
  assert.deepEqual(g.costDomain, [0.01, 1]);
  for (const p of g.points) assert.ok(Math.abs(p.x - 50) < 1e-9);
});

test('plotted coordinates are the log-cost and linear-score positions in the given ranges', () => {
  const g = computeFrontier(FIXTURE, RANGES); // costDomain [0.01, 10] spans 3 decades
  const deepseek = g.points.find((p) => p.arm.canonical_model === 'deepseek-v4-flash-0731')!;
  assert.equal(deepseek.cost, 0.05);
  assert.equal(deepseek.score, 0.778);
  assert.ok(Math.abs(deepseek.x - ((Math.log10(0.05) + 2) / 3) * 100) < 1e-9);
  assert.ok(Math.abs(deepseek.y - (100 - 77.8)) < 1e-9);
  const laguna = FIXTURE[6];
  assert.ok(!g.points.some((p) => p.arm === laguna)); // score 0 but unpriced: never plotted
  // The scales handed back are the ones the points were placed with.
  assert.equal(g.xScale(0.05), deepseek.x);
  assert.equal(g.yScale(0.778), deepseek.y);
});

test('no priced positive cost: free arms sit on the left edge of a default domain', () => {
  const g = computeFrontier(
    [
      arm({ canonical_model: 'f1', label: 'f1', mean_score: 0.8, cost_per_trial: 0, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'f2', label: 'f2', mean_score: 0.2, cost_per_trial: 0, pareto: false, dominated_by: 'f1' }),
      arm({ canonical_model: 'u', label: 'u', mean_score: 0.5, cost_per_trial: null, pareto: false, dominated_by: null }),
    ],
    RANGES,
  );
  assert.deepEqual(g.costDomain, [0.001, 1]);
  assert.deepEqual(g.points.map((p) => p.x), [0, 0]);
  assert.deepEqual(g.points.map((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), [true, true]);
  assert.deepEqual(g.free.map((a) => a.label), ['f1', 'f2']);
  assert.deepEqual(g.unpriced.map((a) => a.label), ['u']);
  assert.deepEqual(g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]), [['f2', 'f1']]);
});

test('empty input yields empty geometry with a usable default domain', () => {
  const g = computeFrontier([], RANGES);
  assert.deepEqual(g.points, []);
  assert.deepEqual(g.frontier, []);
  assert.deepEqual(g.connectors, []);
  assert.deepEqual(g.unpriced, []);
  assert.deepEqual(g.free, []);
  assert.deepEqual(g.costDomain, [0.001, 1]);
});

test('connector rejects a cheaper candidate that scores worse than the dominated arm', () => {
  // Both efforts share canonical_model 'm'. m (cheap) is cheaper than x but
  // scores below it, so it does not dominate x; only m (good) does.
  const g = computeFrontier(
    [
      arm({ canonical_model: 'm', label: 'm (cheap)', mean_score: 0.1, cost_per_trial: 0.01, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'm', label: 'm (good)', mean_score: 0.9, cost_per_trial: 0.05, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'x', label: 'x', mean_score: 0.5, cost_per_trial: 0.1, pareto: false, dominated_by: 'm' }),
    ],
    RANGES,
  );
  assert.deepEqual(g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]), [['x', 'm (good)']]);
});

test('connector accepts a dominator at exactly the same cost with a higher score', () => {
  const g = computeFrontier(
    [
      arm({ canonical_model: 'm', label: 'm', mean_score: 0.9, cost_per_trial: 0.1, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'x', label: 'x', mean_score: 0.5, cost_per_trial: 0.1, pareto: false, dominated_by: 'm' }),
    ],
    RANGES,
  );
  assert.deepEqual(g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]), [['x', 'm']]);
});

test('connector breaks a cost tie between dominating efforts by the higher score', () => {
  const g = computeFrontier(
    [
      arm({ canonical_model: 'm', label: 'm (lo)', mean_score: 0.6, cost_per_trial: 0.05, pareto: false, dominated_by: null }),
      arm({ canonical_model: 'm', label: 'm (hi)', mean_score: 0.8, cost_per_trial: 0.05, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'x', label: 'x', mean_score: 0.5, cost_per_trial: 0.1, pareto: false, dominated_by: 'm' }),
    ],
    RANGES,
  );
  assert.deepEqual(g.connectors.map((c) => [c.from.arm.label, c.to.arm.label]), [['x', 'm (hi)']]);
});

test('an arm dominated by another effort of its own model never links to itself', () => {
  // m (high) is dominated by m (low): same canonical_model. The arm itself
  // trivially satisfies "at least as cheap and as good" and must be excluded.
  const linked = computeFrontier(
    [
      arm({ canonical_model: 'm', label: 'm (high)', mean_score: 0.7, cost_per_trial: 0.4, pareto: false, dominated_by: 'm' }),
      arm({ canonical_model: 'm', label: 'm (low)', mean_score: 0.7, cost_per_trial: 0.1, pareto: true, dominated_by: null }),
    ],
    RANGES,
  );
  assert.deepEqual(linked.connectors.map((c) => [c.from.arm.label, c.to.arm.label]), [['m (high)', 'm (low)']]);

  // With no other effort that dominates it, there is no connector at all.
  const alone = computeFrontier(
    [arm({ canonical_model: 'm', label: 'm (high)', mean_score: 0.7, cost_per_trial: 0.4, pareto: false, dominated_by: 'm' })],
    RANGES,
  );
  assert.deepEqual(alone.connectors, []);
});

test('no connector is drawn when either end is off the cost axis', () => {
  const g = computeFrontier(
    [
      // Dominator is unpriced: nowhere to draw the segment to.
      arm({ canonical_model: 'ghost', label: 'ghost', mean_score: 0.9, cost_per_trial: null, pareto: true, dominated_by: null }),
      arm({ canonical_model: 'x', label: 'x', mean_score: 0.5, cost_per_trial: 0.1, pareto: false, dominated_by: 'ghost' }),
      // Dominated arm is unpriced: it is listed, not plotted.
      arm({ canonical_model: 'y', label: 'y', mean_score: 0.2, cost_per_trial: null, pareto: false, dominated_by: 'z' }),
      arm({ canonical_model: 'z', label: 'z', mean_score: 0.8, cost_per_trial: 0.02, pareto: true, dominated_by: null }),
    ],
    RANGES,
  );
  assert.deepEqual(g.connectors, []);
  assert.deepEqual(g.unpriced.map((a) => a.label), ['ghost', 'y']);
  assert.deepEqual(g.frontier.map((p) => p.arm.label), ['z']); // unpriced pareto arm is not on the polyline
});
