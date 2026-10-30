import { describe, expect, it } from 'vitest';
import { OTHER_COLOR, OTHER_LABEL, SERIES_COLORS } from './components/usage/model-colors';
import { SKILL_TOP_N, skillSeries, stackDay } from './skill-series';

// Twelve skills, ranked s01 (most invocations) to s12, so s11 and s12 fall
// outside the named ten.
const names = Array.from({ length: 12 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
const days = [
  { date: '2026-03-01', total: 78, skills: names.map((skill_name, i) => ({ skill_name, count: 12 - i })) },
  { date: '2026-03-02', total: 3, skills: [{ skill_name: 's01', count: 2 }, { skill_name: 's12', count: 1 }] },
];

describe('skill chart series', () => {
  it('names the top ten, each with its own palette color', () => {
    const { top, colors } = skillSeries(days);
    expect(SKILL_TOP_N).toBe(10);
    expect(top).toEqual(names.slice(0, 10));
    expect(new Set(top.map(name => colors.get(name))).size).toBe(10);
    for (const name of top) expect(SERIES_COLORS).toContain(colors.get(name));
  });

  it('stacks each day in the series order and folds the rest into Other, last', () => {
    const { top, colors } = skillSeries(days);
    expect(stackDay(days[1], top, colors)).toEqual([
      { name: 's01', count: 2, color: colors.get('s01') },
      { name: OTHER_LABEL, count: 1, color: OTHER_COLOR },
    ]);
  });
});
