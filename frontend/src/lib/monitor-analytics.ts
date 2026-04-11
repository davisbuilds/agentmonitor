export type CostWindow = '30d' | '60d' | '90d' | 'all';

export const COST_WINDOW_OPTIONS: Array<{ value: CostWindow; label: string }> = [
  { value: '30d', label: '30d' },
  { value: '60d', label: '60d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

export function buildCostFilters(
  filters: Record<string, string>,
  costWindow: CostWindow,
  now: Date = new Date(),
): Record<string, string> {
  const next = { ...filters };
  if (next.since || costWindow === 'all') return next;

  const days = Number.parseInt(costWindow, 10);
  if (!Number.isFinite(days) || days <= 0) return next;

  next.since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return next;
}

export function formatMonitorCost(value: number | null | undefined): string {
  if (value == null || value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function shortModelName(model: string): string {
  if (!model) return 'unknown';
  return model
    .replace(/claude-sonnet-4-5-\d+/, 'sonnet-4.5')
    .replace(/claude-opus-4-6(-\d+)?/, 'opus-4.6')
    .replace(/claude-opus-4-5-\d+/, 'opus-4.5')
    .replace(/claude-haiku-4-5-\d+/, 'haiku-4.5')
    .replace(/claude-3-5-sonnet-\d+/, 'sonnet-3.5')
    .replace(/claude-3-5-haiku-\d+/, 'haiku-3.5')
    .replace(/claude-3-opus-\d+/, 'opus-3')
    .replace(/^claude-/, 'c-')
    .replace(/^gpt-/, 'gpt-');
}
