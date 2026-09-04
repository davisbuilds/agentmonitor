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

test('isPlottable requires a positive priced cost', () => {
  assert.equal(isPlottable(FIXTURE[0]), true); // luna, $0.479
  assert.equal(isPlottable(FIXTURE[4]), false); // nemotron, null
  assert.equal(isPlottable(arm({ canonical_model: 'x', label: 'x', mean_score: 1, cost_per_trial: 0, pareto: false, dominated_by: null })), false);
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

test('a single priced arm is bracketed to its enclosing decade, not collapsed', () => {
  const g = computeFrontier([FIXTURE[0]], RANGES); // luna, $0.479
  assert.deepEqual(g.costDomain, [0.1, 1]);
  assert.equal(g.points.length, 1);
  assert.ok(g.points[0].x > 0 && g.points[0].x < 100); // lands mid-axis
});
