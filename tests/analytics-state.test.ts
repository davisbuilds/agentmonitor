import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultAnalyticsFilters,
  buildAnalyticsHash,
  parseAnalyticsHash,
  buildAnalyticsCsv,
} from '../frontend/src/lib/analytics-state.ts';

test('createDefaultAnalyticsFilters uses an inclusive last-30-day range', () => {
  const filters = createDefaultAnalyticsFilters(new Date('2026-04-15T12:00:00.000Z'));

  assert.deepEqual(filters, {
    from: '2026-03-17',
    to: '2026-04-15',
    project: '',
    agent: '',
  });
});

test('buildAnalyticsHash and parseAnalyticsHash round-trip analytics filters', () => {
  const hash = buildAnalyticsHash({
    from: '2026-04-01',
    to: '2026-04-15',
    project: 'agentmonitor',
    agent: 'codex',
  });

  assert.equal(hash, 'analytics?from=2026-04-01&to=2026-04-15&project=agentmonitor&agent=codex');
  assert.deepEqual(
    parseAnalyticsHash(`#${hash}`, createDefaultAnalyticsFilters(new Date('2026-04-15T12:00:00.000Z'))),
    {
      from: '2026-04-01',
      to: '2026-04-15',
      project: 'agentmonitor',
      agent: 'codex',
    },
  );
});

test('parseAnalyticsHash falls back for non-analytics hashes and missing params', () => {
  const fallback = createDefaultAnalyticsFilters(new Date('2026-04-15T12:00:00.000Z'));

  assert.deepEqual(parseAnalyticsHash('#sessions', fallback), fallback);
  assert.deepEqual(parseAnalyticsHash('#analytics?project=alpha', fallback), {
    ...fallback,
    project: 'alpha',
  });
});

test('buildAnalyticsCsv emits summary and table sections for export', () => {
  const csv = buildAnalyticsCsv({
    generatedAt: '2026-04-15T12:00:00.000Z',
    filters: {
      from: '2026-04-01',
      to: '2026-04-15',
      project: 'agentmonitor',
      agent: 'claude',
    },
    summary: {
      total_sessions: 12,
      total_messages: 144,
      total_user_messages: 42,
      daily_average_sessions: 0.8,
      daily_average_messages: 9.6,
      date_range: { earliest: '2026-04-01T10:00:00Z', latest: '2026-04-15T18:00:00Z' },
      coverage: {
        metric_scope: 'all_sessions',
        matching_sessions: 12,
        included_sessions: 12,
        excluded_sessions: 0,
        fidelity_breakdown: { full: 10, summary: 2, unknown: 0 },
        capability_breakdown: {
          history: { full: 10, summary: 0, none: 2, unknown: 0 },
          search: { full: 10, summary: 0, none: 2, unknown: 0 },
          tool_analytics: { full: 10, summary: 0, none: 2, unknown: 0 },
          live_items: { full: 10, summary: 2, none: 0, unknown: 0 },
        },
        note: 'All matching sessions are included.',
      },
    },
    velocity: {
      total_sessions: 12,
      total_messages: 144,
      total_user_messages: 42,
      active_days: 8,
      span_days: 15,
      sessions_per_active_day: 1.5,
      messages_per_active_day: 18,
      sessions_per_calendar_day: 0.8,
      messages_per_calendar_day: 9.6,
      average_messages_per_session: 12,
      average_user_messages_per_session: 3.5,
      coverage: {
        metric_scope: 'all_sessions',
        matching_sessions: 12,
        included_sessions: 12,
        excluded_sessions: 0,
        fidelity_breakdown: { full: 10, summary: 2, unknown: 0 },
        capability_breakdown: {
          history: { full: 10, summary: 0, none: 2, unknown: 0 },
          search: { full: 10, summary: 0, none: 2, unknown: 0 },
          tool_analytics: { full: 10, summary: 0, none: 2, unknown: 0 },
          live_items: { full: 10, summary: 2, none: 0, unknown: 0 },
        },
        note: 'All matching sessions are included.',
      },
    },
    activity: [
      { date: '2026-04-01', sessions: 3, messages: 27, user_messages: 8 },
      { date: '2026-04-02', sessions: 2, messages: 14, user_messages: 5 },
    ],
    projects: [
      { project: 'agentmonitor', session_count: 9, message_count: 110, user_message_count: 31 },
    ],
    tools: [
      { tool_name: 'Read', category: 'Read', count: 18 },
    ],
    topSessions: [
      {
        id: 'sess-1',
        project: 'agentmonitor',
        agent: 'claude',
        started_at: '2026-04-10T11:00:00Z',
        ended_at: '2026-04-10T12:00:00Z',
        message_count: 30,
        user_message_count: 9,
        tool_call_count: 5,
        fidelity: 'full',
      },
    ],
    agents: [
      {
        agent: 'claude',
        session_count: 10,
        message_count: 130,
        user_message_count: 39,
        average_messages_per_session: 13,
        full_fidelity_sessions: 10,
        summary_fidelity_sessions: 0,
        tool_analytics_capable_sessions: 10,
        first_started_at: '2026-04-01T10:00:00Z',
        last_started_at: '2026-04-15T18:00:00Z',
      },
    ],
  });

  assert.match(csv, /Section,Metric,Value/);
  assert.match(csv, /Filters,Project,agentmonitor/);
  assert.match(csv, /Summary,Total Sessions,12/);
  assert.match(csv, /Velocity,Messages Per Active Day,18/);
  assert.match(csv, /Activity By Day/);
  assert.match(csv, /Top Sessions/);
  assert.match(csv, /Agent Comparison/);
});
