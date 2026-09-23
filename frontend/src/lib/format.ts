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
  return `${(ms / 1000).toFixed(1)}s`;
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
