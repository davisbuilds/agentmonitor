import type { AnalyticsGitActivity, GitActivityDay } from './api/client';
import type { DailyBar } from './components/ui/chart/daily-bars';
import { agentHexColor } from './format';

/** Commits no session proved: recessive, below every agent's identity color in weight. */
export const OUTSIDE_COLOR = 'var(--color-line-strong)';

export interface GitChart {
  days: DailyBar[];
  byDate: Map<string, GitActivityDay>;
  /** Agents with a commit in the range, in a fixed order, so a filter never repaints them. */
  agents: string[];
  agentCommits: number;
  outside: number;
}

/** One bar per day: each agent's proven commits, bottom up in a fixed order, then commits made outside a session. */
const AGENT_ORDER = ['claude', 'codex', 'antigravity'];

export function gitBars(data: AnalyticsGitActivity | null): GitChart {
  const days = data?.days ?? [];
  const present = new Set(days.flatMap(day => Object.keys(day.by_agent).filter(agent => day.by_agent[agent] > 0)));
  const rank = (agent: string) => {
    const index = AGENT_ORDER.indexOf(agent);
    return index === -1 ? AGENT_ORDER.length : index;
  };
  const agents = [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let agentCommits = 0;
  let outside = 0;
  for (const day of days) {
    for (const agent of agents) agentCommits += day.by_agent[agent] ?? 0;
    outside += day.outside;
  }
  return {
    days: days.map(day => ({
      date: day.date,
      segments: [
        ...agents.map(agent => ({ key: agent, value: day.by_agent[agent] ?? 0, color: agentHexColor(agent) })),
        { key: 'outside', value: day.outside, color: OUTSIDE_COLOR },
      ],
    })),
    byDate: new Map(days.map(day => [day.date, day])),
    agents,
    agentCommits,
    outside,
  };
}
