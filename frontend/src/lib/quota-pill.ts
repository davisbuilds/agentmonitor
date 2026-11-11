import type { QuotaMonitorData, QuotaMonitorWindow } from './api/client';

export interface QuotaPillEntry {
  provider: QuotaMonitorData['provider'];
  label: string;
  /** What is left of the provider's tightest window, 0-100. */
  remainingPercent: number;
  tone: 'ok' | 'warn' | 'danger';
  /** The last good reading, kept through a failed refresh. */
  stale: boolean;
}

export function quotaProviderLabel(row: QuotaMonitorData): string {
  return row.provider === 'claude' ? 'Claude' : 'Codex';
}

export function quotaWindows(row: QuotaMonitorData): QuotaMonitorWindow[] {
  return [row.primary, row.secondary].filter(Boolean) as QuotaMonitorWindow[];
}

/**
 * Whether a snapshot's windows are worth showing: a current reading, or the
 * last good one kept through a failed refresh (shown as stale).
 */
export function quotaShowsWindows(row: QuotaMonitorData): boolean {
  return (row.status === 'available' || row.stale === true) && quotaWindows(row).length > 0;
}

/**
 * One entry per provider with a usable snapshot, for the header pill: the
 * provider's name and what is left of its most-used window.
 */
export function quotaPillEntries(rows: QuotaMonitorData[]): QuotaPillEntry[] {
  const entries: QuotaPillEntry[] = [];
  for (const row of rows) {
    if (!quotaShowsWindows(row)) continue;
    const windows = quotaWindows(row);
    const worst = windows.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
    entries.push({
      provider: row.provider,
      label: quotaProviderLabel(row),
      remainingPercent: Math.round(worst.remaining_percent),
      tone: worst.used_percent >= 85 ? 'danger' : worst.used_percent >= 60 ? 'warn' : 'ok',
      stale: row.status !== 'available',
    });
  }
  return entries;
}

/** The pill's accessible name, e.g. "Quota left: Claude 75%, Codex 98%". */
export function quotaPillLabel(entries: QuotaPillEntry[]): string {
  if (entries.length === 0) return 'Provider quota';
  return `Quota left: ${entries.map(e => `${e.label} ${e.remainingPercent}%${e.stale ? ' (stale)' : ''}`).join(', ')}`;
}
