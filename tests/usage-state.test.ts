import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultUsageFilters,
  buildUsageHash,
  parseUsageHash,
  buildUsageCsv,
} from '../frontend/src/lib/usage-state.ts';
import { csvSection, parseCsv } from './helpers/csv.ts';

test('buildUsageHash and parseUsageHash round-trip usage filters', () => {
  const filters = {
    from: '2026-04-01',
    to: '2026-04-15',
    project: 'agentmonitor',
    agent: 'codex',
    model: 'gpt-5.4',
    provider: 'openai',
    tier: 'standard',
  };

  const hash = buildUsageHash(filters);
  assert.equal(hash, 'usage?from=2026-04-01&to=2026-04-15&project=agentmonitor&agent=codex&model=gpt-5.4&provider=openai&tier=standard');

  assert.deepEqual(parseUsageHash(`#${hash}`, createDefaultUsageFilters(new Date('2026-04-15T12:00:00Z'))), filters);
});

test('parseUsageHash falls back for non-usage hashes and missing params', () => {
  const fallback = {
    from: '2026-03-17',
    to: '2026-04-15',
    project: '',
    agent: '',
    model: '',
    provider: '',
    tier: '',
  };

  assert.deepEqual(parseUsageHash('#analytics?project=alpha', fallback), fallback);
  assert.deepEqual(parseUsageHash('#usage?project=alpha', fallback), {
    from: '2026-03-17',
    to: '2026-04-15',
    project: 'alpha',
    agent: '',
    model: '',
    provider: '',
    tier: '',
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
      model: 'gpt-5.4',
      provider: 'openai',
      tier: 'standard',
    },
    summary: {
      total_cost_usd: 12.34,
      prior_total_cost_usd: 10,
      cost_delta_pct: 23.4,
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
      cache_hit_rate: 0.056604,
      estimated_cache_savings_usd: 0.00081,
      pricing_known_events: 7,
      pricing_unknown_events: 1,
      unknown_model_events: 1,
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
        canonical_model: 'gpt-5.4',
        provider: 'openai',
        family: 'gpt',
        tier: 'standard',
        known: true,
        deprecated: false,
        pricing_status: 'known',
        cost_usd: 8.5,
        input_tokens: 3000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_write_tokens: 20,
        usage_events: 4,
        session_count: 2,
      },
    ],
    tiers: [
      {
        provider: 'openai',
        tier: 'standard',
        cost_usd: 8.5,
        input_tokens: 3000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_write_tokens: 20,
        usage_events: 4,
        session_count: 2,
        unknown_model_events: 0,
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
        primary_model: 'gpt-5.4',
        primary_tier: 'standard',
        primary_provider: 'openai',
        model_count: 1,
        tier_costs: [
          { provider: 'openai', tier: 'standard', cost_usd: 4.56, usage_events: 2 },
        ],
        unknown_model_events: 0,
        browsing_session_available: true,
      },
    ],
  });

  assert.match(csv, /Section,Metric,Value/);
  assert.match(csv, /Summary,Total Cost USD,12\.34/);
  assert.match(csv, /Summary,Prior Total Cost USD,10/);
  assert.match(csv, /Filters,Provider,openai/);
  assert.match(csv, /Daily Usage/);
  assert.match(csv, /Projects/);
  assert.match(csv, /Models/);
  assert.match(csv, /Tiers/);
  assert.match(csv, /Agents/);
  assert.match(csv, /Top Sessions/);
  assert.match(csv, /session-123/);
});

const DISTINCT_USAGE = {
  cost_usd: 1.11,
  input_tokens: 2002,
  output_tokens: 303,
  cache_read_tokens: 404,
  cache_write_tokens: 505,
  usage_events: 6,
  session_count: 7,
};

test('buildUsageCsv puts every value under its own header (no swapped columns)', () => {
  const csv = buildUsageCsv({
    generatedAt: '2026-04-15T12:00:00Z',
    filters: { from: '2026-04-01', to: '2026-04-15', project: '', agent: '', model: '', provider: '', tier: '' },
    summary: null,
    daily: [{ date: '2026-04-10', ...DISTINCT_USAGE }],
    projects: [{ project: 'proj', ...DISTINCT_USAGE }],
    models: [{
      model: 'm-raw', canonical_model: 'm-canon', provider: 'prov', family: 'fam', tier: 'tier-x',
      known: true, deprecated: false, pricing_status: 'known', ...DISTINCT_USAGE,
    }],
    tiers: [{ provider: 'prov', tier: 'tier-x', ...DISTINCT_USAGE, unknown_model_events: 8 }],
    agents: [{ agent: 'codex', ...DISTINCT_USAGE }],
    topSessions: [{
      id: 'sid', project: 'proj', agent: 'codex',
      started_at: '2026-04-10T10:00:00Z', ended_at: null, last_activity_at: '2026-04-10T11:00:00Z',
      message_count: 12, user_message_count: 5, fidelity: 'full',
      ...DISTINCT_USAGE, event_count: 9,
      primary_model: 'm-raw', primary_tier: 'tier-x', primary_provider: 'prov', model_count: 2,
      tier_costs: [], unknown_model_events: 8, browsing_session_available: false,
    }],
  });

  assert.deepEqual(csvSection(csv, 'Daily Usage'), [{
    Date: '2026-04-10', 'Cost USD': '1.11', 'Input Tokens': '2002', 'Output Tokens': '303',
    'Cache Read Tokens': '404', 'Cache Write Tokens': '505', 'Usage Events': '6', Sessions: '7',
  }]);
  assert.deepEqual(csvSection(csv, 'Projects'), [{
    Project: 'proj', 'Cost USD': '1.11', 'Input Tokens': '2002', 'Output Tokens': '303', 'Usage Events': '6', Sessions: '7',
  }]);
  assert.deepEqual(csvSection(csv, 'Models'), [{
    Model: 'm-raw', 'Canonical Model': 'm-canon', Provider: 'prov', Family: 'fam', Tier: 'tier-x',
    'Pricing Status': 'known', 'Cost USD': '1.11', 'Input Tokens': '2002', 'Output Tokens': '303',
    'Usage Events': '6', Sessions: '7',
  }]);
  assert.deepEqual(csvSection(csv, 'Tiers'), [{
    Provider: 'prov', Tier: 'tier-x', 'Cost USD': '1.11', 'Input Tokens': '2002', 'Output Tokens': '303',
    'Cache Read Tokens': '404', 'Cache Write Tokens': '505', 'Usage Events': '6', Sessions: '7', 'Unknown Model Events': '8',
  }]);
  assert.deepEqual(csvSection(csv, 'Agents'), [{
    Agent: 'codex', 'Cost USD': '1.11', 'Input Tokens': '2002', 'Output Tokens': '303', 'Usage Events': '6', Sessions: '7',
  }]);
  assert.deepEqual(csvSection(csv, 'Top Sessions'), [{
    'Session ID': 'sid', Project: 'proj', Agent: 'codex', 'Primary Model': 'm-raw', 'Primary Provider': 'prov',
    'Primary Tier': 'tier-x', 'Model Count': '2', 'Unknown Model Events': '8', 'Cost USD': '1.11',
    'Input Tokens': '2002', 'Output Tokens': '303', 'Usage Events': '6', 'All Events': '9',
    'Started At': '2026-04-10T10:00:00Z', 'Last Activity': '2026-04-10T11:00:00Z', 'Has Browsing Session': 'false',
  }]);
  // Empty filters are labelled, and a null summary emits no summary rows.
  assert.match(csv, /^Filters,Provider,All$/m);
  assert.doesNotMatch(csv, /^Summary,/m);
});

test('buildUsageCsv quotes values containing commas, quotes, or newlines', () => {
  const awkward = 'acme, "inc"\nlab';
  const csv = buildUsageCsv({
    generatedAt: '2026-04-15T12:00:00Z',
    filters: { from: '2026-04-01', to: '2026-04-15', project: awkward, agent: 'two\nlines', model: '', provider: '', tier: '' },
    summary: null,
    daily: [],
    projects: [{ project: awkward, ...DISTINCT_USAGE }],
    models: [],
    tiers: [],
    agents: [],
    topSessions: [],
  });
  assert.ok(csv.includes('"acme, ""inc""\nlab"'));
  assert.equal(csvSection(csv, 'Projects')[0].Project, awkward);
  assert.deepEqual(parseCsv(csv).find(r => r[0] === 'Filters' && r[1] === 'Project'), ['Filters', 'Project', awkward]);
  // A newline alone also forces quoting, or the row splits in two.
  assert.deepEqual(parseCsv(csv).find(r => r[0] === 'Filters' && r[1] === 'Agent'), ['Filters', 'Agent', 'two\nlines']);
  // Empty tables are omitted entirely rather than emitted as bare headers.
  assert.doesNotMatch(csv, /Daily Usage|Top Sessions/);
});
