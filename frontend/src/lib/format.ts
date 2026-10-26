function hasExplicitTimezone(value: string): boolean {
  return /[zZ]$|[+-]\d{2}:\d{2}$/.test(value);
}

function normalizeTimestampInput(value: string): string {
  if (value.includes(' ') && !value.includes('T')) {
    return `${value.replace(' ', 'T')}Z`;
  }
  if (value.includes('T') && !hasExplicitTimezone(value)) {
    return `${value}Z`;
  }
  return value;
}

export function parseTimestamp(value: string): Date {
  return new Date(normalizeTimestampInput(value));
}

export function formatCost(n: number | null | undefined): string {
  if (n == null || n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

const NUMBER_UNITS = [
  { value: 1_000, suffix: 'K' },
  { value: 1_000_000, suffix: 'M' },
  { value: 1_000_000_000, suffix: 'B' },
];

export function formatNumber(n: number): string {
  // Round before settling on a unit: 999,950 rounds to 1000.0K, which must
  // read as 1.0M.
  for (let i = NUMBER_UNITS.length - 1; i >= 0; i--) {
    const unit = NUMBER_UNITS[i];
    if (n < unit.value) continue;
    const rounded = (n / unit.value).toFixed(1);
    const next = NUMBER_UNITS[i + 1];
    if (next && Number(rounded) >= 1_000) return (n / next.value).toFixed(1) + next.suffix;
    return rounded + unit.suffix;
  }
  return n.toLocaleString();
}

export function formatDateOnly(value: string, locales?: Intl.LocalesArgument): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString(locales, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A `YYYY-MM-DD` date range for a window label: "Sep 1 – Sep 30", with the year
 * only when the range leaves the current year.
 */
export function formatDateRange(from: string, to: string, now = new Date()): string {
  const year = String(now.getFullYear());
  const withYear = !from.startsWith(year) || !to.startsWith(year);
  // Read as UTC midnight and format in UTC, so the label shows the calendar
  // day in every time zone.
  const day = (value: string) => new Date(`${value}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  });
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}

/**
 * The one way a model ID is shown: as its vendor names it, without a routing
 * prefix (`anthropic/`), Claude Code's `[1m]` suffix, a Bedrock wrapper or a
 * release date stamp. Mirrors the server's `normalizeModelId`, plus the date.
 * Show the raw ID in a tooltip where the exact spelling matters.
 */
const BEDROCK_ANTHROPIC_ID = /^(?:(?:us|eu|apac|jp|au|ca|us-gov|global)\.)?anthropic\.(.+?)-v\d+(?::\d+)?$/;

export function formatModelName(model: string): string {
  const id = model
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/^(?:anthropic|openai|google)\//, '');
  // Anthropic stamps `-20251001`, OpenAI snapshots `-2026-03-05`.
  return (BEDROCK_ANTHROPIC_ID.exec(id)?.[1] ?? id).replace(/-20\d{2}-?\d{2}-?\d{2}$/, '');
}

/**
 * Filter options for raw model IDs, labelled with `formatModelName`. Where two
 * IDs would read the same (`openai/gpt-5.4` and `gpt-5.4`) they keep their raw
 * spelling: they can select different rows, and an option has no tooltip.
 */
export function modelSelectOptions(models: string[]): Array<{ value: string; label: string }> {
  const counts = new Map<string, number>();
  for (const model of models) {
    const label = formatModelName(model);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return models.map((model) => {
    const label = formatModelName(model);
    return { value: model, label: (counts.get(label) ?? 0) > 1 ? model : label };
  });
}

export function timeAgo(dateStr: string): string {
  const diff = Math.max(0, Date.now() - parseTimestamp(dateStr).getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatTimeOfDay(dateStr: string): string {
  return parseTimestamp(dateStr).toLocaleTimeString();
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

export function agentColor(agentType: string): string {
  switch (agentType) {
    case 'claude':
    case 'claude_code': return 'text-claude';
    case 'codex': return 'text-codex';
    case 'antigravity': return 'text-antigravity';
    default: return 'text-accent';
  }
}

export function agentHexColor(agentType: string): string {
  switch (agentType) {
    case 'claude':
    case 'claude_code': return 'var(--color-claude)';
    case 'codex': return 'var(--color-codex)';
    case 'antigravity': return 'var(--color-antigravity)';
    default: return 'var(--color-accent)';
  }
}

export function agentDisplayName(agentType: string): string {
  switch (agentType) {
    case 'claude':
    case 'claude_code': return 'Claude';
    case 'codex': return 'Codex';
    case 'antigravity': return 'Antigravity';
    default: return 'Assistant';
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-ok';
    case 'idle': return 'bg-warn';
    case 'ended': return 'bg-line-strong';
    case 'error': return 'bg-danger';
    default: return 'bg-line-strong';
  }
}
