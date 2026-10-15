import type { QuotaMonitorData, QuotaMonitorWindow } from './api/client';

export interface QuotaPillEntry {
  provider: QuotaMonitorData['provider'];
  label: string;
  /** What is left of the provider's tightest window, 0-100. */
  remainingPercent: number;
  tone: 'ok' | 'warn' | 'danger';
}

export function quotaProviderLabel(row: QuotaMonitorData): string {
  return row.provider === 'claude' ? 'Claude' : 'Codex';
}

export function quotaWindows(row: QuotaMonitorData): QuotaMonitorWindow[] {
  return [row.primary, row.secondary].filter(Boolean) as QuotaMonitorWindow[];
}

/**
 * One entry per provider with a usable snapshot, for the header pill: the
 * provider's name and what is left of its most-used window.
 */
export function quotaPillEntries(rows: QuotaMonitorData[]): QuotaPillEntry[] {
  const entries: QuotaPillEntry[] = [];
  for (const row of rows) {
    if (row.status !== 'available') continue;
    const windows = quotaWindows(row);
    if (windows.length === 0) continue;
    const worst = windows.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
    entries.push({
      provider: row.provider,
      label: quotaProviderLabel(row),
      remainingPercent: Math.round(worst.remaining_percent),
      tone: worst.used_percent >= 85 ? 'danger' : worst.used_percent >= 60 ? 'warn' : 'ok',
    });
  }
  return entries;
}

/** The pill's accessible name, e.g. "Quota left: Claude 75%, Codex 98%". */
export function quotaPillLabel(entries: QuotaPillEntry[]): string {
  if (entries.length === 0) return 'Provider quota';
  return `Quota left: ${entries.map(e => `${e.label} ${e.remainingPercent}%`).join(', ')}`;
}
