import { describe, expect, it } from 'vitest';
import { dailyBarLayout, shortDate } from './daily-bars';

const day = (date: string, ...values: number[]) => ({
  date,
  segments: values.map((value, i) => ({ key: `k${i}`, value, color: `c${i}` })),
});

describe('daily bar layout', () => {
  it('tops the axis at a round tick at or above the busiest day, and sizes bars against it', () => {
    const layout = dailyBarLayout([day('2026-03-01', 30, 7), day('2026-03-02'), day('2026-03-03', 12)]);
    expect(layout.ticks).toEqual([0, 10, 20, 30, 40]);
    expect(layout.top).toBe(40);
    expect(layout.columns.map(column => [column.total, column.heightPct])).toEqual([[37, 92.5], [0, 0], [12, 30]]);
  });

  it('keeps only positive segments, in order', () => {
    const [column] = dailyBarLayout([day('2026-03-01', 0, 3, 2)]).columns;
    expect(column.segments.map(segment => segment.key)).toEqual(['k1', 'k2']);
  });

  it('labels whole numbers only for a count', () => {
    expect(dailyBarLayout([day('2026-03-01', 1)]).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(dailyBarLayout([day('2026-03-01', 1)], { integer: true }).ticks).toEqual([0, 1]);
  });

  it('has a flat axis and no bar heights for an empty range', () => {
    const layout = dailyBarLayout([day('2026-03-01'), day('2026-03-02')]);
    expect([layout.ticks, layout.top]).toEqual([[0], 0]);
    expect(layout.columns.every(column => column.heightPct === 0)).toBe(true);
  });

  it('labels a handful of dates, always the first and the last', () => {
    const days = Array.from({ length: 30 }, (_, i) => day(`2026-03-${String(i + 1).padStart(2, '0')}`));
    const ticks = [...dailyBarLayout(days).dateTicks].sort((a, b) => a - b);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(29);
    expect(ticks.length).toBeLessThanOrEqual(7);
    // The last label is right-aligned, so the one before it keeps a full step away.
    expect(ticks[ticks.length - 1] - ticks[ticks.length - 2]).toBeGreaterThanOrEqual(ticks[1] - ticks[0]);
    expect(shortDate('2026-03-02')).toBe('03/02');
  });
});
