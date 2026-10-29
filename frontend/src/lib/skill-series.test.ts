import { describe, expect, it } from 'vitest';
import { OTHER_COLOR, OTHER_LABEL, SERIES_COLORS } from './components/usage/model-colors';
import { skillSeries, stackDay } from './skill-series';

const days = [
  { date: '2026-03-01', total: 9, skills: [
    { skill_name: 'write-plan', count: 4 }, { skill_name: 'diagnose', count: 2 }, { skill_name: 'a', count: 1 },
    { skill_name: 'b', count: 1 }, { skill_name: 'c', count: 1 },
  ] },
  { date: '2026-03-02', total: 7, skills: [
    { skill_name: 'diagnose', count: 5 }, { skill_name: 'd', count: 1 }, { skill_name: 'write-plan', count: 1 },
  ] },
];

describe('skill chart series', () => {
  it('names the top five with distinct palette colors and folds the rest into Other', () => {
    const { top, colors } = skillSeries(days);
    expect(top).toEqual(['diagnose', 'write-plan', 'a', 'b', 'c']);
    expect(new Set(top.map(name => colors.get(name))).size).toBe(5);
    for (const name of top) expect(SERIES_COLORS).toContain(colors.get(name));
  });

  it('stacks each day in the series order, Other last', () => {
    const { top, colors } = skillSeries(days);
    expect(stackDay(days[1], top, colors)).toEqual([
      { name: 'diagnose', count: 5, color: colors.get('diagnose') },
      { name: 'write-plan', count: 1, color: colors.get('write-plan') },
      { name: OTHER_LABEL, count: 1, color: OTHER_COLOR },
    ]);
  });
});
