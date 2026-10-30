import { describe, expect, it } from 'vitest';
import { activityBars } from './activity-bars';

describe('activityBars', () => {
  it('scales by sessions, not messages, and leaves idle days empty', () => {
    const { bars, maxSessions, totalSessions } = activityBars([
      { date: '2026-03-01', sessions: 1, messages: 900, user_messages: 3 },
      { date: '2026-03-02', sessions: 0, messages: 0, user_messages: 0 },
      { date: '2026-03-03', sessions: 4, messages: 40, user_messages: 8 },
    ]);
    expect(maxSessions).toBe(4);
    expect(totalSessions).toBe(5);
    expect(bars.map(bar => bar.heightPct)).toEqual([25, 0, 100]);
  });
});
