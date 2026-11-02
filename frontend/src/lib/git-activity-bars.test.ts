import { describe, expect, it } from 'vitest';
import type { AnalyticsGitActivity } from './api/client';
import { gitBars, OUTSIDE_COLOR } from './git-activity-bars';

const activity = (days: AnalyticsGitActivity['days']): AnalyticsGitActivity => ({
  days,
  agents: [],
  projects: [],
  pull_requests: [],
  coverage: { commits: 0, proven: 0, time_only: 0, trailer_without_session: 0 },
});

describe('gitBars', () => {
  it('stacks agents in a fixed order whatever order the data lists them, outside commits on top', () => {
    const chart = gitBars(activity([
      { date: '2026-03-01', by_agent: { codex: 2, claude: 3 }, outside: 1 },
      { date: '2026-03-02', by_agent: { codex: 4 }, outside: 0 },
    ]));
    expect(chart.agents).toEqual(['claude', 'codex']);
    expect(chart.days[0].segments.map(segment => [segment.key, segment.value])).toEqual([['claude', 3], ['codex', 2], ['outside', 1]]);
    expect(chart.days[1].segments.map(segment => segment.key)).toEqual(['claude', 'codex', 'outside']);
    expect(chart.days[0].segments[2].color).toBe(OUTSIDE_COLOR);
    expect([chart.agentCommits, chart.outside]).toEqual([9, 1]);
  });

  it('keeps an agent its color when a filter leaves it alone in the range', () => {
    const both = gitBars(activity([{ date: '2026-03-01', by_agent: { claude: 1, codex: 1 }, outside: 0 }]));
    const codexOnly = gitBars(activity([{ date: '2026-03-01', by_agent: { codex: 1 }, outside: 0 }]));
    const color = (chart: ReturnType<typeof gitBars>) => chart.days[0].segments.find(segment => segment.key === 'codex')?.color;
    expect(color(codexOnly)).toBe(color(both));
  });

  it('draws nothing without data', () => {
    expect(gitBars(null)).toMatchObject({ days: [], agents: [], agentCommits: 0, outside: 0 });
  });
});
