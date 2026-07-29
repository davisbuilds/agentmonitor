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
    skills: [],
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

test('buildAnalyticsCsv emits the skills section when skill usage is present', () => {
  const csv = buildAnalyticsCsv({
    generatedAt: '2026-04-15T12:00:00.000Z',
    filters: {
      from: '2026-04-01',
      to: '2026-04-15',
      project: '',
      agent: '',
    },
    summary: null,
    velocity: null,
    activity: [],
    projects: [],
    tools: [],
    skills: [
      {
        date: '2026-04-11',
        total: 3,
        skills: [
          { skill_name: 'local-review', count: 1 },
          { skill_name: 'github:yeet', count: 1 },
          { skill_name: 'first-principles', count: 1 },
        ],
      },
    ],
    topSessions: [],
    agents: [],
  });

  assert.match(csv, /Skills By Day/);
  assert.match(csv, /2026-04-11,local-review,1/);
  assert.match(csv, /2026-04-11,github:yeet,1/);
  assert.match(csv, /2026-04-11,first-principles,1/);
});

test('buildAnalyticsCsv appends per-harness consultation evidence without changing daily skills', () => {
  const csv = buildAnalyticsCsv({
    generatedAt: '2026-04-15T12:00:00.000Z',
    filters: {
      from: '2026-04-01',
      to: '2026-04-15',
      project: '',
      agent: '',
    },
    summary: null,
    velocity: null,
    activity: [],
    projects: [],
    tools: [],
    skills: [{
      date: '2026-04-11',
      total: 1,
      skills: [{ skill_name: 'write-plan', count: 1 }],
    }],
    skillConsultations: {
      asOf: '2026-04-15T12:00:00.000Z',
      windowSemantics: {
        interval: 'utc_half_open',
        from: '2026-04-01T00:00:00.000Z',
        toExclusive: '2026-04-16T00:00:00.000Z',
        sessionMembership: 'observed_interval_overlap_or_in_window_occurrence',
        windowMembershipUnobservable: 0,
      },
      byHarness: [{
        harness: 'claude',
        detectionSemantics: 'explicit_skill_tool',
        skills: [{
          name: 'write-plan',
          harness: 'claude',
          invocations: 2,
          classes: {
            first_read: 1,
            rehydration_after_compaction: 1,
            repeat_no_compaction: 0,
            unclassifiable: 0,
          },
          sessionsInWindow: 3,
          eligibleSessionsInWindow: 2,
          sessionsWithFirstRead: 1,
          firstReadEngagementRate: 0.5,
          ineligibleSessionsByReason: [{
            reason: 'compaction_visibility_unavailable',
            sessions: 1,
          }],
          projectBreadth: {
            distinctObservedProjects: 1,
            sessions: [{ id: 'agentmonitor', label: 'agentmonitor', sessions: 1 }],
          },
          versions: [{
            version: '1.0.0',
            attribution: 'exact',
            invocations: 2,
            classes: {
              first_read: 1,
              rehydration_after_compaction: 1,
              repeat_no_compaction: 0,
              unclassifiable: 0,
            },
          }],
          exposure: {
            jointlyEligiblePresentedSessions: 2,
            presentedWithFirstRead: 1,
            presentedWithoutFirstRead: 1,
          },
        }],
      }],
      comparability: {
        status: 'not_directly_comparable',
        limitingEvidence: ['different_detection_semantics'],
      },
    },
    topSessions: [],
    agents: [],
  });

  assert.match(csv, /Skills By Day\nDate,Skill,Count\n2026-04-11,write-plan,1/);
  assert.match(csv, /Skill Consultations By Harness/);
  assert.match(
    csv,
    /claude,write-plan,1,2,0.5,1,0,0,1,2,1,1,not_directly_comparable/,
  );
});

test('buildAnalyticsCsv omits an empty consultation section', () => {
  const csv = buildAnalyticsCsv({
    generatedAt: '2026-04-15T12:00:00.000Z',
    filters: {
      from: '2026-04-01',
      to: '2026-04-15',
      project: '',
      agent: 'claude',
    },
    summary: null,
    velocity: null,
    activity: [],
    projects: [],
    tools: [],
    skills: [],
    skillConsultations: {
      asOf: '2026-04-15T12:00:00.000Z',
      windowSemantics: {
        interval: 'utc_half_open',
        from: '2026-04-01T00:00:00.000Z',
        toExclusive: '2026-04-16T00:00:00.000Z',
        sessionMembership: 'observed_interval_overlap_or_in_window_occurrence',
        windowMembershipUnobservable: 0,
      },
      byHarness: [{
        harness: 'claude',
        detectionSemantics: 'explicit_skill_tool',
        skills: [],
      }],
      comparability: {
        status: 'single_harness',
        limitingEvidence: [],
      },
    },
    topSessions: [],
    agents: [],
  });

  assert.doesNotMatch(csv, /Skill Consultations By Harness/);
});
