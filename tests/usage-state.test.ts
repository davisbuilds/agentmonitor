import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultUsageFilters,
  buildUsageHash,
  parseUsageHash,
  buildUsageCsv,
} from '../frontend/src/lib/usage-state.ts';

test('buildUsageHash and parseUsageHash round-trip usage filters', () => {
  const filters = {
    from: '2026-04-01',
    to: '2026-04-15',
    project: 'agentmonitor',
    agent: 'codex',
  };

  const hash = buildUsageHash(filters);
  assert.equal(hash, 'usage?from=2026-04-01&to=2026-04-15&project=agentmonitor&agent=codex');

  assert.deepEqual(parseUsageHash(`#${hash}`, createDefaultUsageFilters(new Date('2026-04-15T12:00:00Z'))), filters);
});

test('parseUsageHash falls back for non-usage hashes and missing params', () => {
  const fallback = {
    from: '2026-03-17',
    to: '2026-04-15',
    project: '',
    agent: '',
  };

  assert.deepEqual(parseUsageHash('#analytics?project=alpha', fallback), fallback);
  assert.deepEqual(parseUsageHash('#usage?project=alpha', fallback), {
    from: '2026-03-17',
    to: '2026-04-15',
    project: 'alpha',
    agent: '',
  });
});

test('buildUsageCsv includes summary and table sections', () => {
  const csv = buildUsageCsv({
    generatedAt: '2026-04-15T12:00:00Z',
    filters: {
      from: '2026-04-01',
      to: '2026-04-15',
      project: '',
      agent: 'codex',
    },
    summary: {
      total_cost_usd: 12.34,
      total_input_tokens: 5000,
      total_output_tokens: 900,
      total_cache_read_tokens: 300,
      total_cache_write_tokens: 100,
      total_usage_events: 8,
      total_sessions: 3,
      active_days: 4,
      span_days: 15,
      average_cost_per_active_day: 3.09,
      average_cost_per_session: 4.11,
      peak_day: { date: '2026-04-10', cost_usd: 4.56 },
      coverage: {
        metric_scope: 'event_usage',
        matching_events: 10,
        usage_events: 8,
        missing_usage_events: 2,
        matching_sessions: 4,
        usage_sessions: 3,
        sources_with_usage: 2,
        source_breakdown: [],
        note: 'Usage comes from event rows with token or cost data.',
      },
    },
    daily: [
      {
        date: '2026-04-10',
        cost_usd: 4.56,
        input_tokens: 2000,
        output_tokens: 300,
        cache_read_tokens: 100,
        cache_write_tokens: 50,
        usage_events: 2,
        session_count: 1,
      },
    ],
    projects: [
      {
        project: 'agentmonitor',
        cost_usd: 10.01,
        input_tokens: 4000,
        output_tokens: 700,
        cache_read_tokens: 250,
        cache_write_tokens: 80,
        usage_events: 5,
        session_count: 2,
      },
    ],
    models: [
      {
        model: 'gpt-5.4',
        cost_usd: 8.5,
        input_tokens: 3000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_write_tokens: 20,
        usage_events: 4,
        session_count: 2,
      },
    ],
    agents: [
      {
        agent: 'codex',
        cost_usd: 8.5,
        input_tokens: 3000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_write_tokens: 20,
        usage_events: 4,
        session_count: 2,
      },
    ],
    topSessions: [
      {
        id: 'session-123',
        project: 'agentmonitor',
        agent: 'codex',
        started_at: '2026-04-10T10:00:00Z',
        ended_at: '2026-04-10T10:30:00Z',
        last_activity_at: '2026-04-10T10:30:00Z',
        message_count: 12,
        user_message_count: 5,
        fidelity: 'full',
        cost_usd: 4.56,
        input_tokens: 2000,
        output_tokens: 300,
        cache_read_tokens: 100,
        cache_write_tokens: 50,
        event_count: 3,
        usage_events: 2,
        browsing_session_available: true,
      },
    ],
  });

  assert.match(csv, /Section,Metric,Value/);
  assert.match(csv, /Summary,Total Cost USD,12\.34/);
  assert.match(csv, /Daily Usage/);
  assert.match(csv, /Projects/);
  assert.match(csv, /Models/);
  assert.match(csv, /Agents/);
  assert.match(csv, /Top Sessions/);
  assert.match(csv, /session-123/);
});
