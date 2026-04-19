import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampInsightDateRange,
  insightMatchesListFilters,
  sameInsightListFilters,
  type InsightListFilters,
} from '../frontend/src/lib/insights-state.ts';
import type { Insight } from '../frontend/src/lib/api/client.ts';

const baseFilters: InsightListFilters = {
  from: '2026-03-01',
  to: '2026-03-31',
  project: 'alpha',
  agent: 'claude',
  kind: 'workflow',
};

const baseInsight: Insight = {
  id: 1,
  kind: 'workflow',
  title: 'Workflow Insight',
  prompt: null,
  content: '# Workflow Insight',
  date_from: '2026-03-01',
  date_to: '2026-03-31',
  project: 'alpha',
  agent: 'claude',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  analytics_summary: {
    total_sessions: 1,
    total_messages: 10,
    total_user_messages: 5,
    daily_average_sessions: 1,
    daily_average_messages: 10,
    date_range: { earliest: '2026-03-01T10:00:00Z', latest: '2026-03-01T11:00:00Z' },
    coverage: {
      metric_scope: 'all_sessions',
      matching_sessions: 1,
      included_sessions: 1,
      excluded_sessions: 0,
      fidelity_breakdown: { full: 1, summary: 0, unknown: 0 },
      capability_breakdown: {
        history: { full: 1, summary: 0, none: 0, unknown: 0 },
        search: { full: 1, summary: 0, none: 0, unknown: 0 },
        tool_analytics: { full: 1, summary: 0, none: 0, unknown: 0 },
        live_items: { full: 1, summary: 0, none: 0, unknown: 0 },
      },
      note: 'All matching sessions are included.',
    },
  },
  analytics_coverage: {
    metric_scope: 'all_sessions',
    matching_sessions: 1,
    included_sessions: 1,
    excluded_sessions: 0,
    fidelity_breakdown: { full: 1, summary: 0, unknown: 0 },
    capability_breakdown: {
      history: { full: 1, summary: 0, none: 0, unknown: 0 },
      search: { full: 1, summary: 0, none: 0, unknown: 0 },
      tool_analytics: { full: 1, summary: 0, none: 0, unknown: 0 },
      live_items: { full: 1, summary: 0, none: 0, unknown: 0 },
    },
    note: 'All matching sessions are included.',
  },
  usage_summary: {
    total_cost_usd: 1.25,
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_usage_events: 2,
    total_sessions: 1,
    active_days: 1,
    span_days: 1,
    average_cost_per_active_day: 1.25,
    average_cost_per_session: 1.25,
    peak_day: { date: '2026-03-01', cost_usd: 1.25 },
    coverage: {
      metric_scope: 'event_usage',
      matching_events: 2,
      usage_events: 2,
      missing_usage_events: 0,
      matching_sessions: 1,
      usage_sessions: 1,
      sources_with_usage: 1,
      source_breakdown: [],
      note: 'Usage comes from event rows with token or cost data.',
    },
  },
  usage_coverage: {
    metric_scope: 'event_usage',
    matching_events: 2,
    usage_events: 2,
    missing_usage_events: 0,
    matching_sessions: 1,
    usage_sessions: 1,
    sources_with_usage: 1,
    source_breakdown: [],
    note: 'Usage comes from event rows with token or cost data.',
  },
  input_snapshot: {
    analytics_activity: [],
    analytics_projects: [],
    analytics_tools: [],
    analytics_hour_of_week: [],
    analytics_top_sessions: [],
    analytics_velocity: {
      total_sessions: 1,
      total_messages: 10,
      total_user_messages: 5,
      active_days: 1,
      span_days: 1,
      sessions_per_active_day: 1,
      messages_per_active_day: 10,
      sessions_per_calendar_day: 1,
      messages_per_calendar_day: 10,
      average_messages_per_session: 10,
      average_user_messages_per_session: 5,
      coverage: {
        metric_scope: 'all_sessions',
        matching_sessions: 1,
        included_sessions: 1,
        excluded_sessions: 0,
        fidelity_breakdown: { full: 1, summary: 0, unknown: 0 },
        capability_breakdown: {
          history: { full: 1, summary: 0, none: 0, unknown: 0 },
          search: { full: 1, summary: 0, none: 0, unknown: 0 },
          tool_analytics: { full: 1, summary: 0, none: 0, unknown: 0 },
          live_items: { full: 1, summary: 0, none: 0, unknown: 0 },
        },
        note: 'All matching sessions are included.',
      },
    },
    analytics_agents: [],
    usage_daily: [],
    usage_projects: [],
    usage_models: [],
    usage_agents: [],
    usage_top_sessions: [],
  },
  created_at: '2026-04-17T12:00:00Z',
};

test('sameInsightListFilters distinguishes active list slices', () => {
  assert.equal(sameInsightListFilters(baseFilters, { ...baseFilters }), true);
  assert.equal(sameInsightListFilters(baseFilters, { ...baseFilters, project: 'beta' }), false);
});

test('insightMatchesListFilters only matches the active insight slice', () => {
  assert.equal(insightMatchesListFilters(baseInsight, baseFilters), true);
  assert.equal(insightMatchesListFilters(baseInsight, { ...baseFilters, project: 'beta' }), false);
  assert.equal(insightMatchesListFilters(baseInsight, { ...baseFilters, agent: 'codex' }), false);
  assert.equal(insightMatchesListFilters(baseInsight, { ...baseFilters, kind: 'usage' }), false);
  assert.equal(insightMatchesListFilters(baseInsight, { ...baseFilters, from: '2026-04-01', to: '2026-04-30' }), false);
});

test('clampInsightDateRange keeps the range valid when one side crosses the other', () => {
  assert.deepEqual(
    clampInsightDateRange('2026-04-20', '2026-04-10', 'from'),
    { from: '2026-04-20', to: '2026-04-20' },
  );

  assert.deepEqual(
    clampInsightDateRange('2026-04-20', '2026-04-10', 'to'),
    { from: '2026-04-10', to: '2026-04-10' },
  );

  assert.deepEqual(
    clampInsightDateRange('2026-04-10', '2026-04-20', 'from'),
    { from: '2026-04-10', to: '2026-04-20' },
  );
});
