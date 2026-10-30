import type { AnalyticsDelegation, DelegationSplit } from './api/client';
import type { DailyBar } from './components/ui/chart/daily-bars';
import { SERIES_COLORS } from './components/usage/model-colors';

export type DelegationMetric = 'sessions' | 'messages' | 'cost_usd';

export const DELEGATION_METRICS: Array<{ id: DelegationMetric; label: string }> = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'messages', label: 'Messages' },
  { id: 'cost_usd', label: 'Cost' },
];

/** Two series of the validated palette: the work someone started, and the work it delegated. */
export const DELEGATION_COLORS = { started: SERIES_COLORS[0], delegated: SERIES_COLORS[1] };

export interface DelegationChart {
  days: DailyBar[];
  byDate: Map<string, DelegationSplit>;
  started: number;
  delegated: number;
  /** The delegated part of the range's total; null when there is none. */
  share: number | null;
}

/** One bar per day, started work below and delegated work (subagents and Codex's own threads) above. */
export function delegationBars(data: AnalyticsDelegation | null, metric: DelegationMetric): DelegationChart {
  const delegatedOf = (split: DelegationSplit) => split.subagent + split.internal;
  const days = (data?.days ?? []).map(day => ({
    date: day.date,
    segments: [
      { key: 'started', value: day[metric].started, color: DELEGATION_COLORS.started },
      { key: 'delegated', value: delegatedOf(day[metric]), color: DELEGATION_COLORS.delegated },
    ],
  }));
  const totals = data?.totals[metric] ?? { started: 0, subagent: 0, internal: 0 };
  const started = totals.started;
  const delegated = delegatedOf(totals);
  return {
    days,
    byDate: new Map((data?.days ?? []).map(day => [day.date, day[metric]])),
    started,
    delegated,
    share: started + delegated > 0 ? delegated / (started + delegated) : null,
  };
}
