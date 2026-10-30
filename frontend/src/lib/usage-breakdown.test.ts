import { describe, expect, it } from 'vitest';
import type { UsagePriorCosts } from './api/client';
import { breakdownRows, type BreakdownSource } from './usage-breakdown';

const tokens = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 1 };
const source: BreakdownSource = {
  models: [],
  projects: [
    { project: 'alpha', cost_usd: 3, ...tokens, usage_events: 2, session_count: 1 },
    { project: 'unknown', cost_usd: 1, ...tokens, usage_events: 1, session_count: 1 },
  ],
  agents: [{ agent: 'claude_code', cost_usd: 4, ...tokens, usage_events: 3, session_count: 2 }],
  tiers: [],
};
const prior: UsagePriorCosts = {
  range: { from: '2026-02-27', to: '2026-03-01' },
  projects: { alpha: 2 },
  models: {},
  tiers: {},
  agents: { claude_code: 8 },
};

describe('usage breakdown rows', () => {
  it('gives each row its share of the cost and its change against the period before', () => {
    const rows = breakdownRows('project', source, prior);
    expect(rows.map(row => [row.label, row.share, row.change?.value])).toEqual([
      ['alpha', 0.75, '+50%'],
      ['No project', 0.25, 'new'],
    ]);
    expect(rows[0].tokens).toBe(116);
  });

  it('lets project and agent rows filter the page; the unattributed bucket clears the filter', () => {
    expect(breakdownRows('project', source, prior).map(row => row.filter)).toEqual([
      { kind: 'project', value: 'alpha' },
      { kind: 'project', value: '' },
    ]);
    expect(breakdownRows('agent', source, prior)[0]).toMatchObject({ label: 'Claude Code', change: { value: '-50%', tone: 'ok' } });
  });

  it('says a jump of ten times or more as a multiple, not thousands of percent', () => {
    const jump = { ...prior, projects: { alpha: 0.02 } };
    expect(breakdownRows('project', source, jump)[0].change).toEqual({ value: '150×', tone: 'danger' });
  });

  it('has no change without a period before, and no share when nothing cost anything', () => {
    expect(breakdownRows('project', source, { ...prior, range: null })[0].change).toBeNull();
    const free = { ...source, projects: [{ ...source.projects[0], cost_usd: 0 }] };
    expect(breakdownRows('project', free, null)[0].share).toBeNull();
  });
});
