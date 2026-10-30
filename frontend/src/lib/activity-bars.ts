import type { ActivityDataPoint } from './api/client';
import type { DailyBar } from './components/ui/chart/daily-bars';

/** Activity bars encode sessions per day, the measure the panel names. */
export function activityBars(points: ActivityDataPoint[]): { days: DailyBar[]; maxSessions: number; totalSessions: number } {
  const days = points.map(point => ({
    date: point.date,
    segments: [{ key: 'sessions', value: point.sessions, color: 'var(--color-accent)' }],
  }));
  const maxSessions = Math.max(0, ...points.map(point => point.sessions));
  const totalSessions = points.reduce((sum, point) => sum + point.sessions, 0);
  return { days, maxSessions, totalSessions };
}
