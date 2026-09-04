// Pure scale + tick helpers for the app's inline-SVG charts.
//
// Zero DOM/Svelte coupling: a Scale maps a domain value to a viewBox
// coordinate, and the tick helpers produce "nice" round label values. Marks
// and composition stay per-view (see BenchmarkFrontier, CostDashboard); this
// module is only the shared arithmetic so two divergent charts agree on it.

export interface Scale {
  /** Map a domain value to a range (viewBox) coordinate. */
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

function interpolate(t: number, [r0, r1]: readonly [number, number]): number {
  return r0 + t * (r1 - r0);
}

/**
 * Linear domain → range map. A degenerate (zero-width) domain maps every value
 * to the range start so callers never divide by zero or emit NaN coordinates.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const span = d1 - d0;
  const scale = ((value: number): number => {
    if (span === 0) return range[0];
    return interpolate((value - d0) / span, range);
  }) as Scale;
  return Object.assign(scale, { domain, range });
}

/**
 * Log10 domain → range map for positive domains (e.g. $/trial spanning orders
 * of magnitude). Non-positive inputs have no log position and are clamped to
 * the domain floor; callers that must not plot them should filter first.
 */
export function log10Scale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const l0 = Math.log10(domain[0]);
  const l1 = Math.log10(domain[1]);
  const span = l1 - l0;
  const scale = ((value: number): number => {
    if (span === 0) return range[0];
    const lv = value > 0 ? Math.log10(value) : l0;
    return interpolate((lv - l0) / span, range);
  }) as Scale;
  return Object.assign(scale, { domain, range });
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / 10 ** exp;
  let nice: number;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else {
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
  }
  return nice * 10 ** exp;
}

/**
 * "Nice" round tick values covering [min, max] for a linear axis, roughly
 * `count` of them. Returns a single tick for a degenerate range.
 */
export function niceLinearTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const step = niceNum(niceNum(max - min, false) / Math.max(count - 1, 1), true);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Round each step to the step's own precision so 0.1 + 0.2 style drift does
  // not produce 0.30000000000000004 labels.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  for (let v = start; v <= end + step * 0.5; v += step) {
    ticks.push(Number(v.toFixed(decimals)));
  }
  return ticks;
}

/**
 * Decade (power-of-ten) ticks spanning [min, max] for a log10 axis. Both bounds
 * must be positive; the returned ticks bracket the domain.
 */
export function log10Ticks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > 0)) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) ticks.push(10 ** e);
  return ticks;
}

/** Compact USD label for an axis tick: `$0.01`, `$0.5`, `$1`, `$12`. */
export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 1) return `$${Number(v.toPrecision(2))}`;
  if (v >= 100) return `$${v.toFixed(0)}`;
  return `$${Number(v.toFixed(2))}`;
}
