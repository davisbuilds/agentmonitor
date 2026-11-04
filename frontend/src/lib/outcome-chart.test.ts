import { describe, expect, it } from 'vitest';
import type { AnalyticsOutcomes, OutcomeCoverage, OutcomeWeek } from './api/client';
import { OTHER_COLOR, SERIES_COLORS } from './components/usage/model-colors';
import { coverageNotes, landedShare, OUTCOME_ORDER, OUTCOME_STYLE, outcomeParts, spendSegments, weekSeries } from './outcome-chart';

const coverage: OutcomeCoverage = {
  observable_share: 0.965,
  lookups: true,
  github_merged: 40,
  github_linked: 30,
  truncated_commit_lists: 0,
  membership: { github: 30, local: 0, none: 0 },
};

function outcomes(spend: AnalyticsOutcomes['spend']): AnalyticsOutcomes {
  return {
    total_usd: spend.reduce((sum, row) => sum + row.usd, 0),
    spend,
    merged_prs: { prs: 0, median_usd: null, p25_usd: null, p75_usd: null, p90_usd: null, all_in_usd: null },
    weeks: [],
    sizes: [],
    unknown_size: 0,
    projects: [],
    coverage,
  };
}

describe('where the spend went', () => {
  it('lists every class in fixed order with its own color, whichever classes a range has', () => {
    // Out of order, with classes missing: the bar must not reorder or repaint.
    const some = spendSegments(outcomes([
      { outcome: 'not_landed', usd: 1, share: 0.05 },
      { outcome: 'merged_pr', usd: 19, share: 0.95 },
    ]));
    const all = spendSegments(outcomes(OUTCOME_ORDER.map(outcome => ({ outcome, usd: 1, share: 1 / 6 }))));
    expect(some.map(s => s.outcome)).toEqual(OUTCOME_ORDER);
    expect(some.map(s => s.color)).toEqual(all.map(s => s.color));
    expect(some.find(s => s.outcome === 'direct')).toMatchObject({ usd: 0, share: 0, labelled: false });
    expect(some.find(s => s.outcome === 'merged_pr')).toMatchObject({ usd: 19, share: 0.95, labelled: true, label: 'Merged pull request' });
    expect(some.find(s => s.outcome === 'not_landed')?.labelled).toBe(false);
    expect(spendSegments(null).map(s => s.share)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('draws its colors from the validated palette, one per class', () => {
    const colors = OUTCOME_ORDER.map(outcome => OUTCOME_STYLE[outcome].color);
    expect(new Set(colors).size).toBe(colors.length);
    for (const color of colors) expect([...SERIES_COLORS, OTHER_COLOR]).toContain(color);
  });

  it('keeps merged pull requests\' figures when the range itself has no spend', () => {
    // A pull request merged in the range costs the work before it, up to a month
    // earlier, so it has figures even when none of that spend falls in the range.
    const earlier = { ...outcomes([]), merged_prs: { prs: 2, median_usd: 3, p25_usd: 2, p75_usd: 4, p90_usd: 5, all_in_usd: null } };
    expect(outcomeParts(earlier)).toEqual({ spend: false, merged: true });
    expect(outcomeParts(outcomes([{ outcome: 'nothing_after', usd: 1, share: 1 }]))).toEqual({ spend: true, merged: false });
    expect(outcomeParts(null)).toEqual({ spend: false, merged: false });
  });

  it('counts merged pull requests, pushes and other landings as landed', () => {
    expect(landedShare(outcomes([
      { outcome: 'merged_pr', usd: 6, share: 0.6 },
      { outcome: 'direct', usd: 2, share: 0.2 },
      { outcome: 'other_landed', usd: 1, share: 0.1 },
      { outcome: 'nothing_after', usd: 1, share: 0.1 },
    ]))).toBeCloseTo(0.9);
    expect(landedShare(outcomes([]))).toBeNull();
  });
});

describe('the weekly series', () => {
  const week = (weekStart: string, median: number | null, extra: Partial<OutcomeWeek> = {}): OutcomeWeek => ({
    week: weekStart, prs: median === null ? 0 : 3, median_usd: median, p25_usd: median && median / 2, p75_usd: median && median * 2, p90_usd: null,
    median_tokens: median && median * 1000, usd_per_mtok: median && 0.5, ...extra,
  });

  it('keeps each week at its place in the range, leaving a gap for a week without merges', () => {
    const weeks = [week('2026-10-05', 4), week('2026-10-12', null), week('2026-10-19', 6)];
    expect(weekSeries(weeks, 'median_usd')).toEqual([
      { index: 0, week: '2026-10-05', value: 4, prs: 3, low: 2, high: 8 },
      { index: 2, week: '2026-10-19', value: 6, prs: 3, low: 3, high: 12 },
    ]);
    expect(weekSeries(weeks, 'median_tokens').map(p => [p.index, p.value, p.low])).toEqual([[0, 4000, null], [2, 6000, null]]);
  });
});

describe('coverage notes', () => {
  it('says how much spend could be followed and how many merged pull requests it reached', () => {
    expect(coverageNotes(coverage)).toEqual([
      '97% of the spend could be followed to a session\'s work.',
      '30 of the 40 pull requests merged on GitHub in this range are linked to a session here; the rest came from elsewhere, such as another machine.',
    ]);
  });

  it('says what is lost with GitHub lookups off, and when commit lists were cut short', () => {
    const notes = coverageNotes({ ...coverage, lookups: false, github_merged: null, github_linked: null, truncated_commit_lists: 2 });
    expect(notes[1]).toMatch(/GitHub lookups are off/);
    expect(notes[1]).toMatch(/squash/);
    expect(notes[2]).toBe('2 merged pull requests have more than 100 commits; only the first 100 are linked to their work.');
    expect(coverageNotes(null)).toEqual([]);
  });

  it('says why GitHub\'s count is missing under a filter', () => {
    expect(coverageNotes({ ...coverage, github_merged: null, github_linked: null })[1]).toMatch(/without a project or agent filter/);
  });
});
