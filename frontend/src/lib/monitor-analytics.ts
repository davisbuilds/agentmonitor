import { createDefaultAnalyticsFilters } from './analytics-state';

export interface MonitorCostWindows {
  today: Record<string, string>;
  last30Days: Record<string, string>;
}

/**
 * Usage API params for the Monitor's two cost figures. The 30-day window is the
 * one Usage's default 30D range uses, so the two pages show the same number.
 * Only the project and agent filters carry over, as they did for the Monitor's
 * cost panel before.
 */
export function monitorCostWindowParams(
  filters: Record<string, string>,
  now: Date = new Date(),
): MonitorCostWindows {
  const usageDefault = createDefaultAnalyticsFilters(now);
  const scope: Record<string, string> = {};
  if (filters.project) scope.project = filters.project;
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

  const suffix = [cleanModelName(model), reasoningEffort].filter(Boolean).join(' ');
  return `${name} (${suffix})`;
}
