// WHY: Plot the backend’s Pareto decisions directly. Keeping geometry pure lets tests distinguish a
// rendering regression from a ranking change.

import type { BenchmarkArm } from '../../api/client';
import { log10Scale, linearScale, type Scale } from '../ui/chart/scales';

export interface FrontierArmPoint {
  arm: BenchmarkArm;
  cost: number;
  score: number;
  /** viewBox x (from the log10 cost scale). */
  x: number;
  /** viewBox y (from the linear score scale, inverted for SVG). */
  y: number;
  onFrontier: boolean;
}

export interface FrontierConnector {
  /** The dominated arm. */
  from: FrontierArmPoint;
  /** The arm that dominates it. */
  to: FrontierArmPoint;
}

export interface FrontierRanges {
  /** viewBox x range [left, right]. */
  xRange: readonly [number, number];
  /** viewBox y range [bottom, top] — pass [height, 0] to invert for SVG. */
  yRange: readonly [number, number];
}

export interface FrontierGeometry {
  /** Plottable arms (priced; a free $0 arm is pinned to the left edge). */
  points: FrontierArmPoint[];
  /** Pareto-frontier arms ordered by cost ascending — the polyline path. */
  frontier: FrontierArmPoint[];
  /** Dominated → dominator segments, both endpoints plottable. */
  connectors: FrontierConnector[];
  /** Arms with no cost-axis position (null cost — genuinely unpriced). */
  unpriced: BenchmarkArm[];
  /** Priced-but-free ($0) arms; plotted at the left edge, not unpriced. */
  free: BenchmarkArm[];
  /** The log10 cost domain actually used (after single-point padding). */
  costDomain: [number, number];
  xScale: Scale;
  yScale: Scale;
}

/**
 * An arm sits on the cost axis if it has a priced cost, including an
 * authoritative $0 (a genuinely free route) — which the log scale pins to the
 * left edge. Only a null cost (never priced) is truly off-axis.
 */
export function isPlottable(arm: BenchmarkArm): boolean {
  return arm.cost_per_trial != null;
}

export function computeFrontier(arms: BenchmarkArm[], ranges: FrontierRanges): FrontierGeometry {
  const plottable = arms.filter(isPlottable);
  const unpriced = arms.filter((a) => a.cost_per_trial == null);
  const free = plottable.filter((a) => a.cost_per_trial === 0);

  // WHY: Exclude zero-cost points from the log domain so they can remain visible at the clamped plot
  // edge.
  const positiveCosts = plottable
    .map((a) => a.cost_per_trial as number)
    .filter((c) => c > 0);
  let costDomain: [number, number];
  if (positiveCosts.length === 0) {
    costDomain = [0.001, 1];
  } else {
    // WHY: Use full decades for plot bounds and widen a collapsed domain to keep its scale usable.
    let lo = Math.floor(Math.log10(Math.min(...positiveCosts)));
    let hi = Math.ceil(Math.log10(Math.max(...positiveCosts)));
    if (hi === lo) {
      lo -= 1;
      hi += 1;
    }
    costDomain = [10 ** lo, 10 ** hi];
  }

  const xScale = log10Scale(costDomain, ranges.xRange);
  const yScale = linearScale([0, 1], ranges.yRange);

  const points: FrontierArmPoint[] = plottable.map((arm) => {
    const cost = arm.cost_per_trial as number;
    const score = arm.mean_score;
    return { arm, cost, score, x: xScale(cost), y: yScale(score), onFrontier: arm.pareto };
  });

  const frontier = points
    .filter((p) => p.onFrontier)
    .sort((a, b) => a.cost - b.cost);

  // WHY: Several effort variants share one canonical model. Match a dominator that qualifies against
  // this arm before choosing a connector.
  const connectors: FrontierConnector[] = [];
  for (const p of points) {
    const dom = p.arm.dominated_by;
    if (!dom) continue;
    const target = points
      .filter(
        (q) =>
          q !== p &&
          q.arm.canonical_model === dom &&
          q.cost <= p.cost &&
          q.score >= p.score,
      )
      .sort((a, b) => a.cost - b.cost || b.score - a.score)[0];
    if (target) connectors.push({ from: p, to: target });
  }

  return { points, frontier, connectors, unpriced, free, costDomain, xScale, yScale };
}
