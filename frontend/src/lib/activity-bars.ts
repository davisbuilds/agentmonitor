import type { ActivityDataPoint } from './api/client';

export interface ActivityBar {
  date: string;
  sessions: number;
  messages: number;
  /** Bar height as a percent of the busiest day's sessions; an idle day is 0. */
  heightPct: number;
}

/** Activity bars encode sessions per day, the measure the panel names. */
export function activityBars(points: ActivityDataPoint[]): { bars: ActivityBar[]; maxSessions: number; totalSessions: number } {
  const maxSessions = Math.max(0, ...points.map(point => point.sessions));
  const bars = points.map(point => ({
    date: point.date,
    sessions: point.sessions,
    messages: point.messages,
    heightPct: maxSessions > 0 ? (point.sessions / maxSessions) * 100 : 0,
  }));
  const totalSessions = points.reduce((sum, point) => sum + point.sessions, 0);
  return { bars, maxSessions, totalSessions };
}
