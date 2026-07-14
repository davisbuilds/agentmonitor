/**
 * Series selection and color assignment for the Top Models chart.
 *
 * Pure, and separate from the component, so the color invariants can actually be
 * tested: they are data-dependent and the failure mode is silent (two categories
 * rendering in one color still draws a perfectly plausible chart).
 */

export type UsageMetric = 'cost' | 'tokens';

/** Structural shape only — this module does not care where the rows came from. */
export interface ModelSliceLike {
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ModelDailyPointLike {
  models: ModelSliceLike[];
}

export const TOP_N = 5;

// Validated against the dark chart surface (#101419): lightness band, chroma
// floor, adjacent-pair CVD separation (worst ΔE 15.7), and 3:1 contrast all pass.
// Order is the CVD-safety mechanism, not cosmetic — do not reshuffle without
// re-validating. Green and red are omitted deliberately: they read as the
// reserved ok/danger status tokens.
export const SERIES_COLORS = ['#3987e5', '#199e70', '#c98500', '#d55181', '#9085e9', '#d95926'];

/** Reserved for the aggregated series; never assigned to a named model. */
export const OTHER_COLOR = '#82878c';
export const OTHER_LABEL = 'Other';

// A set needs at most TOP_N distinct hues, so this headroom is what lets
// assignModelColors() always find a free color. Guard the invariant here rather
// than discovering it as a gray series in the chart.
if (TOP_N > SERIES_COLORS.length) {
  throw new Error(`Top Models needs at least ${TOP_N} series colors, got ${SERIES_COLORS.length}`);
}

/**
 * Fixed order, and deliberately not the selected metric: it is what makes the color
 * assignment independent of which toggle is currently active.
 */
export const METRICS: UsageMetric[] = ['cost', 'tokens'];

export function measure(slice: ModelSliceLike, metric: UsageMetric): number {
  return metric === 'cost' ? slice.cost_usd : slice.input_tokens + slice.output_tokens;
}

/** Models ranked over the whole range, so a model keeps its stack slot across days. */
export function rankModels(points: readonly ModelDailyPointLike[], metric: UsageMetric): string[] {
  const totals = new Map<string, number>();
  for (const point of points) {
    for (const slice of point.models) {
      totals.set(slice.model, (totals.get(slice.model) ?? 0) + measure(slice, metric));
    }
  }

  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([model]) => model);
}

/**
 * A model's hue must survive the metric toggle, so colors cannot be handed out by
 * rank — that repaints every survivor the moment the ranking changes. But they also
 * cannot be keyed to the cost ranking alone: a token-heavy, cheap model can enter the
 * Tokens top-N while sitting outside it, and would fall through to Other's gray,
 * putting two different categories on one color.
 *
 * So color the union of every metric's top-N — every model that can actually appear —
 * in a fixed order that ignores the current selection. Two passes, in priority order:
 *
 *  1. A hue nobody else has. While the palette holds out, a color means exactly one
 *     model for the life of the range, so toggling the metric cannot change what blue
 *     means, even for a model that leaves the chart and comes back.
 *  2. Failing that, a hue unused by the models it is actually shown beside. Only two
 *     near-disjoint top-N sets can exhaust six colors, and those sets are never on
 *     screen together, so the legend stays unambiguous in every individual view.
 *
 * The floor that makes (2) total is TOP_N <= SERIES_COLORS.length, asserted above.
 */
export function assignModelColors(points: readonly ModelDailyPointLike[]): Map<string, string> {
  const rankedByMetric = METRICS.map(metric => rankModels(points, metric));

  // Deterministic and metric-independent: the union, ordered by the first metric that
  // ranks each model. Iterating the selection instead would reintroduce the repaint.
  const universe = [...new Set(rankedByMetric.flat())];

  const assigned = new Map<string, string>();
  const usedAnywhere = new Set<string>();

  for (const model of universe) {
    const shownBeside = new Set<string>();
    for (const ranked of rankedByMetric) {
      if (!ranked.includes(model)) continue;
      for (const peer of ranked) {
        const color = assigned.get(peer);
        if (color) shownBeside.add(color);
      }
    }

    const color = SERIES_COLORS.find(candidate => !usedAnywhere.has(candidate))
      ?? SERIES_COLORS.find(candidate => !shownBeside.has(candidate));
    if (!color) throw new Error(`Ran out of series colors assigning ${model}`);

    assigned.set(model, color);
    usedAnywhere.add(color);
  }

  return assigned;
}
