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

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
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
    case 'claude_code': return 'text-orange-400';
    case 'codex': return 'text-gray-300';
    default: return 'text-blue-400';
  }
}

export function agentHexColor(agentType: string): string {
  switch (agentType) {
    case 'claude':
    case 'claude_code': return '#fb923c';
    case 'codex': return '#d1d5db';
    default: return '#60a5fa';
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-400';
    case 'idle': return 'bg-yellow-400';
    case 'ended': return 'bg-gray-500';
    case 'error': return 'bg-red-400';
    default: return 'bg-gray-500';
  }
}
