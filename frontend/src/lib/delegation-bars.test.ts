import { describe, expect, it } from 'vitest';
import { delegationBars, DELEGATION_COLORS } from './delegation-bars';
import type { AnalyticsDelegation } from './api/client';

const split = (started: number, subagent: number, internal: number) => ({ started, subagent, internal });
const data: AnalyticsDelegation = {
  days: [
    { date: '2026-03-02', sessions: split(1, 1, 0), messages: split(10, 4, 0), cost_usd: split(1, 0.25, 0) },
    { date: '2026-03-03', sessions: split(1, 1, 3), messages: split(20, 6, 0), cost_usd: split(2, 0.5, 0.1) },
  ],
  totals: { sessions: split(2, 2, 3), messages: split(30, 10, 0), cost_usd: split(3, 0.75, 0.1) },
};

describe('delegationBars', () => {
  it('stacks the chosen measure: started below, subagents and Codex threads together above', () => {
    const chart = delegationBars(data, 'sessions');
    expect(chart.days.map(day => day.segments.map(segment => [segment.key, segment.value, segment.color]))).toEqual([
      [['started', 1, DELEGATION_COLORS.started], ['delegated', 1, DELEGATION_COLORS.delegated]],
      [['started', 1, DELEGATION_COLORS.started], ['delegated', 4, DELEGATION_COLORS.delegated]],
    ]);
    expect([chart.started, chart.delegated, chart.share]).toEqual([2, 5, 5 / 7]);
    expect(chart.byDate.get('2026-03-03')).toEqual(split(1, 1, 3));
  });

  it('reads cost and messages from their own fields', () => {
    expect(delegationBars(data, 'cost_usd').days[1].segments.map(segment => segment.value)).toEqual([2, 0.6]);
    expect(delegationBars(data, 'messages').share).toBe(0.25);
  });

  it('has no share without work, and no bars without data', () => {
    const idle: AnalyticsDelegation = { days: [{ date: '2026-03-02', sessions: split(0, 0, 0), messages: split(0, 0, 0), cost_usd: split(0, 0, 0) }], totals: { sessions: split(0, 0, 0), messages: split(0, 0, 0), cost_usd: split(0, 0, 0) } };
    expect(delegationBars(idle, 'sessions').share).toBeNull();
    expect(delegationBars(null, 'sessions').days).toEqual([]);
  });
});
