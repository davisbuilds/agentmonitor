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
    .replace(/claude-opus-4-7(-\d+)?/, 'opus-4.7')
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

interface ActiveAgentLabelEvent {
  model?: string;
  metadata?: Record<string, unknown> | string;
}

function parseMetadata(metadata: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return metadata;
}

function cleanModelName(model: string): string {
  return model.replace(/^(openai|anthropic|google)\//, '');
}

function reasoningEffortFromEvent(event: ActiveAgentLabelEvent): string | null {
  const metadata = parseMetadata(event.metadata);
  for (const key of ['reasoning_effort', 'thinking_level']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

export function buildActiveAgentLabel(agentType: string, events: ActiveAgentLabelEvent[]): string {
  const model = events.find(event => event.model?.trim())?.model?.trim();
  const reasoningEffort = events.map(reasoningEffortFromEvent).find((value): value is string => value != null);

  if (!model) return agentType;

  const suffix = [cleanModelName(model), reasoningEffort].filter(Boolean).join(' ');
  return `${agentType} (${suffix})`;
}
