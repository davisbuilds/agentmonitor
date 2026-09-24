import type { AgentEvent, MonitorAgentUsage, Stats } from './api/client';

export interface AgentTokenRow {
  agent: string;
  label: string;
  total: number;
  usage: MonitorAgentUsage;
}

const AGENT_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

/**
 * Every token an agent processed: uncached input, output, cache reads and
 * writes. Claude's `/stats` and Codex's `/usage` both count tokens this way.
 */
export function usageTotal(usage: MonitorAgentUsage): number {
  return usage.tokens_in + usage.tokens_out + usage.cache_read_tokens + usage.cache_write_tokens;
}

export function statsTotalTokens(stats: Stats): number {
  return stats.total_tokens_in + stats.total_tokens_out
    + (stats.total_cache_read_tokens ?? 0) + (stats.total_cache_write_tokens ?? 0);
}

export function agentTokenRows(stats: Stats): AgentTokenRow[] {
  return Object.entries(stats.usage_by_agent ?? {})
    .map(([agent, usage]) => ({ agent, label: AGENT_LABELS[agent] ?? agent, total: usageTotal(usage), usage }))
    .sort((a, b) => b.total - a.total);
}

/** Add a live event's usage to the running totals until the next stats snapshot. */
export function addEventUsage(stats: Stats, event: AgentEvent): Stats {
  const delta: MonitorAgentUsage = {
    tokens_in: event.tokens_in || 0,
    tokens_out: event.tokens_out || 0,
    cache_read_tokens: event.cache_read_tokens || 0,
    cache_write_tokens: event.cache_write_tokens || 0,
    cost_usd: event.cost_usd || 0,
  };
  const current = stats.usage_by_agent?.[event.agent_type]
    ?? { tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
  return {
    ...stats,
    total_tokens_in: stats.total_tokens_in + delta.tokens_in,
    total_tokens_out: stats.total_tokens_out + delta.tokens_out,
    total_cache_read_tokens: (stats.total_cache_read_tokens ?? 0) + delta.cache_read_tokens,
    total_cache_write_tokens: (stats.total_cache_write_tokens ?? 0) + delta.cache_write_tokens,
    total_cost_usd: stats.total_cost_usd + delta.cost_usd,
    usage_by_agent: {
      ...stats.usage_by_agent,
      [event.agent_type]: {
        tokens_in: current.tokens_in + delta.tokens_in,
        tokens_out: current.tokens_out + delta.tokens_out,
        cache_read_tokens: current.cache_read_tokens + delta.cache_read_tokens,
        cache_write_tokens: current.cache_write_tokens + delta.cache_write_tokens,
        cost_usd: current.cost_usd + delta.cost_usd,
      },
    },
  };
}
