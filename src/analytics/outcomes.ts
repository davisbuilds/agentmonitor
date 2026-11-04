/**
 * Cost per outcome, the parts that need no database: allocating cost along a
 * session's timeline, PR size buckets, and per-project estimates pooled toward
 * the overall figure. getAnalyticsOutcomes reads the rows these take.
 */

/** Where a minute of spend went, in the order every view lists them. */
export const OUTCOME_CLASSES = ['merged_pr', 'direct', 'other_landed', 'not_landed', 'nothing_after', 'unobservable'] as const;
export type OutcomeClass = typeof OUTCOME_CLASSES[number];
/** What a milestone came to: the classes a milestone can carry. */
export type MilestoneOutcome = Exclude<OutcomeClass, 'nothing_after' | 'unobservable'>;

/** A minute of spend in one root session (null: no session here to read it from). */
export interface CostMinute {
  root: string | null;
  /** The minute's start, epoch ms. */
  at: number;
  /** False when the root's sessions have no tool calls stored, so no milestone could be seen. */
  observable: boolean;
}

/** Something a root session produced: a credited commit, or a pull request it opened. */
export interface Milestone {
  root: string;
  at: number;
  outcome: MilestoneOutcome;
}

/**
 * Each minute's class and milestone under the "next" rule: the first milestone
 * of the same root at or after the minute's start. Work leads to output, so a
 * minute goes to what it led to; one with nothing after it is `nothing_after`.
 */
export function allocate<S extends Milestone>(minutes: CostMinute[], milestones: S[]): Array<{ outcome: OutcomeClass; milestone: S | null }> {
  const byRoot = new Map<string, S[]>();
  for (const milestone of milestones) {
    const list = byRoot.get(milestone.root);
    if (list) list.push(milestone);
    else byRoot.set(milestone.root, [milestone]);
  }
  for (const list of byRoot.values()) list.sort((a, b) => a.at - b.at);
  return minutes.map(minute => {
    if (minute.root === null || !minute.observable) return { outcome: 'unobservable', milestone: null };
    const list = byRoot.get(minute.root) ?? [];
    // The first milestone at or after the minute, by binary search.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid].at < minute.at) low = mid + 1;
      else high = mid;
    }
    const milestone = list[low] ?? null;
    return milestone ? { outcome: milestone.outcome, milestone } : { outcome: 'nothing_after', milestone: null };
  });
}

/** Fixed buckets of lines changed, stable across ranges (quartiles would move with them). */
export const SIZE_BUCKETS = ['<200', '200-499', '500-999', '1000+'] as const;
export type SizeBucket = typeof SIZE_BUCKETS[number];

export function sizeBucket(lines: number): SizeBucket {
  if (lines < 200) return '<200';
  if (lines < 500) return '200-499';
  if (lines < 1000) return '500-999';
  return '1000+';
}

/** The q-quantile of ascending values, interpolating linearly between ranks. */
export function quantile(sorted: number[], q: number): number {
  const rank = (sorted.length - 1) * q;
  const below = Math.floor(rank);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (rank - below);
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
/** Sample variance (n - 1). */
const variance = (values: number[]) => {
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
};
/** τ²'s floor: no between-project spread to measure still leaves each project its own weight. */
const MIN_BETWEEN_VARIANCE = 1e-6;

export interface PooledProject {
  project: string;
  prs: number;
  median_usd: number;
  /** The project's typical cost, pulled toward the overall one as far as its few PRs warrant. */
  pooled_usd: number;
}

/**
 * Per-project cost per PR with partial pooling. Most spread is between PRs in
 * one project, so a project's own figure on a few PRs says little: its mean
 * log cost is shrunk toward the overall mean by τ²/(τ² + σ²/n), with σ² the
 * within-project variance and τ² the between-project variance by method of
 * moments (floored, so a single project keeps its own figure). Costs must be
 * positive.
 */
export function poolProjects(groups: Array<{ project: string; costs: number[] }>): PooledProject[] {
  const logs = groups.map(group => group.costs.map(Math.log));
  const all = logs.flat();
  const grand = mean(all);
  const spread = logs.filter(values => values.length > 1).map(variance);
  const within = spread.length > 0 ? mean(spread) : 0;
  const between = logs.length > 1
    ? Math.max(variance(logs.map(mean)) - mean(logs.map(values => within / values.length)), MIN_BETWEEN_VARIANCE)
    : MIN_BETWEEN_VARIANCE;
  return groups.map((group, index) => {
    const own = mean(logs[index]);
    const weight = between / (between + within / logs[index].length);
    return {
      project: group.project,
      prs: group.costs.length,
      median_usd: quantile([...group.costs].sort((a, b) => a - b), 0.5),
      pooled_usd: Math.exp(weight * own + (1 - weight) * grand),
    };
  });
}
