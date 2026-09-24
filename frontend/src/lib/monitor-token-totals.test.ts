import { describe, it, expect } from 'vitest';
import type { AgentEvent, MonitorAgentUsage, Stats } from './api/client';
import { addEventUsage, agentTokenRows, statsTotalTokens, usageTotal } from './monitor-token-totals';

const usage = (tokens_in: number, tokens_out: number, cache_read_tokens: number, cache_write_tokens: number, cost_usd = 0): MonitorAgentUsage =>
  ({ tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd });

function stats(byAgent: Record<string, MonitorAgentUsage>): Stats {
  const all = Object.values(byAgent);
  const sum = (k: keyof MonitorAgentUsage) => all.reduce((n, u) => n + u[k], 0);
  return {
    total_events: 0, active_sessions: 0, live_sessions: 0, total_sessions: 0, active_agents: 0,
    total_tokens_in: sum('tokens_in'), total_tokens_out: sum('tokens_out'),
    total_cache_read_tokens: sum('cache_read_tokens'), total_cache_write_tokens: sum('cache_write_tokens'),
    total_cost_usd: sum('cost_usd'), usage_by_agent: byAgent,
    tool_breakdown: {}, agent_breakdown: {}, model_breakdown: {}, branches: [],
  };
}

describe('Monitor token totals', () => {
  it('counts every bucket, cache included, as the harnesses do', () => {
    expect(usageTotal(usage(3, 40, 9_000, 800))).toBe(9_843);
    expect(statsTotalTokens(stats({ codex: usage(107, 11, 1_070, 0), claude_code: usage(3, 40, 9_000, 800) }))).toBe(11_031);
  });

  it('lists agents by total tokens, largest first, with display names', () => {
    const rows = agentTokenRows(stats({ codex: usage(107, 11, 1_070, 0), claude_code: usage(3, 40, 9_000, 800), mystery: usage(1, 0, 0, 0) }));
    expect(rows.map((r) => [r.agent, r.label, r.total])).toEqual([
      ['claude_code', 'Claude Code', 9_843],
      ['codex', 'Codex', 1_188],
      ['mystery', 'mystery', 1],
    ]);
  });

  it('adds a live event to its agent and to the totals, cache included', () => {
    const before = stats({ codex: usage(100, 10, 1_000, 0, 0.5) });
    const event = { id: 1, agent_type: 'codex', tokens_in: 5, tokens_out: 2, cache_read_tokens: 50, cost_usd: 0.1 } as AgentEvent;
    const after = addEventUsage(before, event);
    expect(after.usage_by_agent.codex).toEqual(usage(105, 12, 1_050, 0, 0.6));
    expect([after.total_tokens_in, after.total_tokens_out, after.total_cache_read_tokens, after.total_cache_write_tokens])
      .toEqual([105, 12, 1_050, 0]);
    expect(after.total_cost_usd).toBeCloseTo(0.6);
    expect(before.usage_by_agent.codex.tokens_in).toBe(100);
  });

  it('starts an agent it has not seen and treats missing fields as zero', () => {
    const after = addEventUsage(stats({}), { id: 1, agent_type: 'claude_code', tokens_in: 1 } as AgentEvent);
    expect(after.usage_by_agent.claude_code).toEqual(usage(1, 0, 0, 0, 0));
    expect(statsTotalTokens(after)).toBe(1);
  });
});
