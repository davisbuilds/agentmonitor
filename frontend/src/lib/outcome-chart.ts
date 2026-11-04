/**
 * Cost per outcome, shaped for the Git view: where the spend went as fixed
 * segments, the weekly series, and the coverage notes. Pure, so the color and
 * order invariants can be tested: a class missing from one range must not
 * repaint the others, and that failure still draws a plausible chart.
 */
import type { AnalyticsOutcomes, OutcomeClass, OutcomeCoverage, OutcomeWeek } from './api/client';
import { OTHER_COLOR, SERIES_COLORS } from './components/usage/model-colors';

/**
 * Each class's name and color, in the order every view lists them. Colors are
 * series of the validated palette plus Other for spend no session could be
 * followed through (tests/series-palette.test.ts checks every pair of them).
 */
export const OUTCOME_STYLE: Record<OutcomeClass, { label: string; color: string }> = {
  merged_pr: { label: 'Merged pull request', color: SERIES_COLORS[0] },
  direct: { label: 'Pushed to main', color: SERIES_COLORS[2] },
  other_landed: { label: 'Landed another way', color: SERIES_COLORS[4] },
  not_landed: { label: 'Not landed', color: SERIES_COLORS[1] },
  nothing_after: { label: 'Nothing after it', color: SERIES_COLORS[5] },
  unobservable: { label: 'Not traceable', color: OTHER_COLOR },
};
export const OUTCOME_ORDER: OutcomeClass[] = ['merged_pr', 'direct', 'other_landed', 'not_landed', 'nothing_after', 'unobservable'];
/** The classes that count as landed on main. */
const LANDED: OutcomeClass[] = ['merged_pr', 'direct', 'other_landed'];

/** A segment narrower than this share carries no label inside the bar; the legend names it. */
export const SEGMENT_LABEL_SHARE = 0.1;

export interface SpendSegment {
  outcome: OutcomeClass;
  label: string;
  color: string;
  usd: number;
  share: number;
  /** Wide enough to name inside the bar. */
  labelled: boolean;
}

/** Every class, in fixed order with its fixed color, whether or not the range has any. */
export function spendSegments(data: AnalyticsOutcomes | null): SpendSegment[] {
  const byClass = new Map((data?.spend ?? []).map(row => [row.outcome, row]));
  return OUTCOME_ORDER.map(outcome => {
    const row = byClass.get(outcome);
    const share = row?.share ?? 0;
    return { outcome, ...OUTCOME_STYLE[outcome], usd: row?.usd ?? 0, share, labelled: share >= SEGMENT_LABEL_SHARE };
  });
}

/** The share of the range's spend that preceded work landing on main; null without spend. */
export function landedShare(data: AnalyticsOutcomes | null): number | null {
  if (!data || data.total_usd <= 0) return null;
  return data.spend.filter(row => LANDED.includes(row.outcome)).reduce((sum, row) => sum + row.share, 0);
}

export type WeekMetric = 'median_usd' | 'median_tokens' | 'usd_per_mtok';

export interface WeekPoint {
  /** The week's position in the range, so a week without merges leaves a gap. */
  index: number;
  week: string;
  value: number;
  prs: number;
  /** For the median: the middle half of the week's pull requests. */
  low: number | null;
  high: number | null;
}

/** The weeks with a value for the metric, each at its place in the range. */
export function weekSeries(weeks: OutcomeWeek[], metric: WeekMetric): WeekPoint[] {
  const points: WeekPoint[] = [];
  weeks.forEach((week, index) => {
    const value = week[metric];
    if (value === null) return;
    const band = metric === 'median_usd';
    points.push({ index, week: week.week, value, prs: week.prs, low: band ? week.p25_usd : null, high: band ? week.p75_usd : null });
  });
  return points;
}

/** Plain sentences on what the figures rest on. */
export function coverageNotes(coverage: OutcomeCoverage | null): string[] {
  if (!coverage) return [];
  const notes: string[] = [];
  if (coverage.observable_share !== null) {
    notes.push(`${Math.round(coverage.observable_share * 100)}% of the spend could be followed to a session's work.`);
  }
  if (!coverage.lookups) {
    notes.push('GitHub lookups are off, so merged state and commit lists come from local merge commits: a squash-merged branch\'s commits count as not landed, and how many of your merged pull requests are linked here is unknown.');
  } else if (coverage.github_merged === null || coverage.github_linked === null) {
    notes.push('How many of GitHub\'s merged pull requests are linked here is shown without a project or agent filter, which GitHub cannot apply.');
  } else {
    notes.push(`${coverage.github_linked} of the ${coverage.github_merged} pull requests merged on GitHub in this range are linked to a session here; the rest came from elsewhere, such as another machine.`);
  }
  const cut = coverage.truncated_commit_lists;
  if (cut > 0) notes.push(`${cut} merged pull request${cut === 1 ? ' has' : 's have'} more than 100 commits; only the first 100 are linked to their work.`);
  return notes;
}
