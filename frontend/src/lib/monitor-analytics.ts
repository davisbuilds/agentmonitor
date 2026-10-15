import { createDefaultAnalyticsFilters } from './analytics-state';
import { formatModelName } from './format';

export interface MonitorCostWindows {
  today: Record<string, string>;
  last30Days: Record<string, string>;
}

/**
 * Usage API params for the Monitor's two cost figures. The 30-day window is the
 * one Usage's default 30D range uses, so the two pages show the same number.
 * The agent filter, Monitor's only one, carries over.
 */
export function monitorCostWindowParams(
  filters: Record<string, string>,
  now: Date = new Date(),
): MonitorCostWindows {
  const usageDefault = createDefaultAnalyticsFilters(now);
  const scope: Record<string, string> = {};
  if (filters.agent_type) scope.agent = filters.agent_type;
  return {
    today: { ...scope, date_from: usageDefault.to, date_to: usageDefault.to },
    last30Days: { ...scope, date_from: usageDefault.from, date_to: usageDefault.to },
  };
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

// Claude Code writes "<synthetic>" as the model for locally-generated assistant
// turns (rate-limit notices, API errors, login prompts) rather than real API
// responses. It is not a model, so it must never surface in the agent label —
// skip it and fall through to the last genuine model instead.
function isRealModel(model: string | undefined): model is string {
  const trimmed = model?.trim();
  return !!trimmed && trimmed !== '<synthetic>';
}

// Friendly name for the agent in the live label. Recognized agents get their
// product name (claude_code → "Claude"); anything else falls back to the raw
// type so unknown runtimes stay identifiable rather than collapsing to a label.
function agentLabelName(agentType: string): string {
  switch (agentType) {
    case 'claude':
    case 'claude_code': return 'Claude';
    case 'codex': return 'Codex';
    case 'antigravity': return 'Antigravity';
    default: return agentType;
  }
}

export function buildActiveAgentLabel(agentType: string, events: ActiveAgentLabelEvent[]): string {
  const name = agentLabelName(agentType);
  const model = events.map(event => event.model?.trim()).find(isRealModel);
  const reasoningEffort = events.map(reasoningEffortFromEvent).find((value): value is string => value != null);

  if (!model) return name;

  const suffix = [formatModelName(model), reasoningEffort].filter(Boolean).join(' ');
  return `${name} (${suffix})`;
}

export interface EventRun<T> {
  /** The newest event of the run, which the row shows. */
  event: T;
  label: string;
  count: number;
}

/**
 * Fold consecutive events with the same label into one row, so a card reads
 * "llm_response ×8" rather than listing the same line eight times. `key` can
 * add what else a row shows (its status), so a run never hides a failure.
 */
export function collapseEventRuns<T>(
  events: readonly T[],
  label: (event: T) => string,
  key: (event: T) => string = label,
): EventRun<T>[] {
  const runs: Array<EventRun<T> & { key: string }> = [];
  for (const event of events) {
    const runKey = key(event);
    const last = runs.at(-1);
    if (last && last.key === runKey) last.count += 1;
    else runs.push({ event, label: label(event), count: 1, key: runKey });
  }
  return runs.map(({ event, label: text, count }) => ({ event, label: text, count }));
}
