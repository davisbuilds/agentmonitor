// Labels for the Overview headline tiles: how each value moved against the
// period before. Pure, so the arithmetic and wording are testable.

export type ChangeTone = 'ok' | 'danger' | 'muted';

/** Which way is worse: cost and errors rising is a cost; volume rising is neither. */
export type ChangeSense = 'up-is-bad' | 'neutral';

export interface ChangeLabel {
  value: string;
  tone: ChangeTone;
}

function tone(change: number, sense: ChangeSense): ChangeTone {
  if (sense === 'neutral' || change === 0) return 'muted';
  return change > 0 ? 'danger' : 'ok';
}

/** Percent change from the period before; none when there is nothing to compare with. */
export function percentChange(value: number, prior: number | null, sense: ChangeSense = 'neutral'): ChangeLabel | null {
  if (prior === null || prior === 0) return null;
  const change = ((value - prior) / prior) * 100;
  const rounded = Math.round(change);
  return { value: `${rounded > 0 ? '+' : ''}${rounded}%`, tone: tone(rounded, sense) };
}

/** A rate's change in percentage points, since a percent of a percent misleads. */
export function pointChange(rate: number | null, prior: number | null, sense: ChangeSense = 'up-is-bad'): ChangeLabel | null {
  if (rate === null || prior === null) return null;
  const points = Math.round((rate - prior) * 1000) / 10;
  return { value: `${points > 0 ? '+' : ''}${points.toFixed(1)} pt`, tone: tone(points, sense) };
}

export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function formatHours(hours: number): string {
  return hours >= 100 ? `${Math.round(hours)} h` : `${hours.toFixed(1)} h`;
}
