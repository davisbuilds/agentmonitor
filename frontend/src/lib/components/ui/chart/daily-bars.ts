// Geometry for DailyBarChart: one bar per day, stacked by segment, on a
// round-tick y axis. Pure, so the arithmetic is testable without a DOM.
import { niceLinearTicks } from './scales';

export interface BarSegment {
  key: string;
  value: number;
  color: string;
}

export interface DailyBar {
  date: string;
  segments: BarSegment[];
}

export interface DailyBarColumn {
  date: string;
  total: number;
  /** Bar height as a percent of the axis top; an empty day is 0. */
  heightPct: number;
  /** The day's positive segments, in the order given (bottom first). */
  segments: BarSegment[];
  day: DailyBar;
}

export interface DailyBarLayout {
  columns: DailyBarColumn[];
  /** y tick values from 0 to the axis top. */
  ticks: number[];
  /** The value at the top of the plot: the highest tick, at or above the busiest day. */
  top: number;
  /** Columns that carry a date label: a handful, always the first and last. */
  dateTicks: Set<number>;
}

export function dailyBarLayout(
  days: DailyBar[],
  { integer = false, tickCount = 5, maxDateTicks = 6 }: { integer?: boolean; tickCount?: number; maxDateTicks?: number } = {},
): DailyBarLayout {
  const columns = days.map(day => {
    const segments = day.segments.filter(segment => segment.value > 0);
    return { date: day.date, total: segments.reduce((sum, segment) => sum + segment.value, 0), heightPct: 0, segments, day };
  });
  const max = Math.max(0, ...columns.map(column => column.total));
  let ticks = max > 0 ? niceLinearTicks(0, max, tickCount) : [0];
  // A count has no half sessions; keep whole ticks (0 and the top always are).
  if (integer) ticks = ticks.filter(Number.isInteger);
  const top = ticks[ticks.length - 1];
  for (const column of columns) column.heightPct = top > 0 ? (column.total / top) * 100 : 0;
  return { columns, ticks, top, dateTicks: dateTickIndexes(columns.length, maxDateTicks) };
}

/** Label a handful of columns, never all of them: a label under every day collides on a 30-day range. */
function dateTickIndexes(count: number, max: number): Set<number> {
  const ticks = new Set<number>();
  if (count === 0) return ticks;
  const target = Math.min(max, count);
  const step = Math.max(1, Math.round((count - 1) / Math.max(1, target - 1)));
  let last = 0;
  for (let i = 0; i < count; i += step) last = i;
  for (let i = 0; i <= last; i += step) ticks.add(i);
  // The last label is right-aligned under its column; drop a label that would
  // sit closer to it than one step, or the two collide on a narrow plot.
  if (last > 0 && count - 1 - last < step) ticks.delete(last);
  ticks.add(count - 1);
  return ticks;
}

/** `2026-03-02` → `03/02`, the axis's short form. */
export function shortDate(date: string): string {
  return date.slice(5).replace('-', '/');
}
