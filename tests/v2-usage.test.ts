import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl = '';
let tempDir = '';
let closeDb: (() => void) | null = null;

function sampleJsonl(lines: object[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

function makeSession(sessionId: string, project: string, startDate: string): string {
  return sampleJsonl([
    {
      type: 'user',
      sessionId,
      cwd: `/Users/dev/${project}`,
      message: { role: 'user', content: [{ type: 'text', text: `Start ${project}` }] },
      timestamp: startDate,
    },
    {
      type: 'assistant',
      sessionId,
      cwd: `/Users/dev/${project}`,
      message: { role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'Working...' }] },
      timestamp: new Date(new Date(startDate).getTime() + 60_000).toISOString(),
    },
  ]);
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-usage-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  initSchema();

  const { parseSessionMessages, insertParsedSession } = await import('../src/parser/claude-code.js');
  const { insertEvent } = await import('../src/db/queries.js');
  const db = dbModule.getDb();

  const parsed = parseSessionMessages(
    makeSession('usage-sess-001', 'alpha', '2026-04-01T09:55:00Z'),
    'usage-sess-001',
    '/fake/projects/alpha/usage-sess-001.jsonl',
  );
  insertParsedSession(db, parsed, '/fake/projects/alpha/usage-sess-001.jsonl', 512, 'usage-hash-001');

  const events = [
    {
      event_id: 'usage-event-001',
      session_id: 'usage-sess-001',
      agent_type: 'claude_code',
      event_type: 'assistant',
      status: 'success' as const,
      project: 'alpha',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 1000,
      tokens_out: 200,
      cache_read_tokens: 400,
      cache_write_tokens: 100,
      cost_usd: 0.012,
      client_timestamp: '2026-04-01T10:00:00Z',
      source: 'import',
    },
    {
      event_id: 'usage-event-002',
      session_id: 'usage-sess-001',
      agent_type: 'claude_code',
      event_type: 'assistant',
      status: 'success' as const,
      project: 'alpha',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 600,
      tokens_out: 100,
      cost_usd: 0.008,
      client_timestamp: '2026-04-01T10:05:00Z',
      source: 'import',
    },
    {
      event_id: 'usage-event-003',
      session_id: 'usage-sess-002',
      agent_type: 'codex',
      event_type: 'assistant',
      status: 'success' as const,
      project: 'beta',
      model: 'gpt-5.4',
      tokens_in: 2000,
      tokens_out: 500,
      cost_usd: 0.03,
      client_timestamp: '2026-04-02T09:00:00Z',
      source: 'otel',
    },
    {
      event_id: 'usage-event-004',
      session_id: 'usage-sess-002',
      agent_type: 'codex',
      event_type: 'tool_result',
      status: 'success' as const,
      project: 'beta',
      tokens_in: 0,
      tokens_out: 0,
      client_timestamp: '2026-04-02T09:05:00Z',
      source: 'otel',
    },
    {
      event_id: 'usage-event-005',
      session_id: 'usage-sess-003',
      agent_type: 'codex',
      event_type: 'assistant',
      status: 'success' as const,
      project: 'alpha',
      model: 'gpt-5.4',
      tokens_in: 1500,
      tokens_out: 300,
      cost_usd: 0.02,
      client_timestamp: '2026-04-03T08:00:00Z',
      source: 'api',
    },
    {
      event_id: 'usage-event-006',
      session_id: 'usage-sess-004',
      agent_type: 'codex',
      event_type: 'assistant',
      status: 'success' as const,
      project: 'gamma',
      model: 'unknown-expensive-model',
      tokens_in: 300,
      tokens_out: 50,
      cache_read_tokens: 70,
      cost_usd: 0.015,
      client_timestamp: '2026-04-03T10:00:00Z',
      source: 'api',
    },
    {
      event_id: 'usage-event-007',
      session_id: 'usage-sess-005',
      agent_type: 'claude_code',
      event_type: 'assistant',
      status: 'success' as const,
      project: 'legacy',
      model: 'claude-3-opus-20240229',
      tokens_in: 100,
      tokens_out: 10,
      cost_usd: 0.005,
      client_timestamp: '2026-04-04T10:00:00Z',
      source: 'api',
    },
  ];

  for (const event of events) {
    insertEvent(event);
  }

  const { createApp } = await import('../src/app.js');
  const app = createApp({ serveStatic: false });
  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
  if (closeDb) closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api/v2/usage/summary', () => {
  test('returns event-derived totals with coverage metadata', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/summary?date_from=2026-04-01&date_to=2026-04-03`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read_tokens: number;
      total_cache_write_tokens: number;
      total_usage_events: number;
      total_sessions: number;
      active_days: number;
      cache_hit_rate: number;
      estimated_cache_savings_usd: number;
      pricing_known_events: number;
      pricing_unknown_events: number;
      unknown_model_events: number;
      prior_total_cost_usd: number;
      cost_delta_pct: number;
      peak_day: { date: string | null; cost_usd: number };
      coverage: {
        metric_scope: string;
        matching_events: number;
        usage_events: number;
        missing_usage_events: number;
        matching_sessions: number;
        usage_sessions: number;
        source_breakdown: Array<{ source: string; event_count: number; usage_event_count: number }>;
      };
    };

    assert.equal(body.total_cost_usd, 0.085);
    assert.equal(body.total_input_tokens, 5400);
    assert.equal(body.total_output_tokens, 1150);
    assert.equal(body.total_cache_read_tokens, 470);
    assert.equal(body.total_cache_write_tokens, 100);
    assert.equal(body.total_usage_events, 5);
    assert.equal(body.total_sessions, 4);
    assert.equal(body.active_days, 3);
    assert.equal(body.cache_hit_rate, 0.080068);
    assert.equal(body.estimated_cache_savings_usd, 0.001005);
    assert.equal(body.pricing_known_events, 4);
    assert.equal(body.pricing_unknown_events, 1);
    assert.equal(body.unknown_model_events, 1);
    assert.equal(body.prior_total_cost_usd, 0);
    assert.equal(body.cost_delta_pct, 0);
    assert.deepEqual(body.peak_day, { date: '2026-04-03', cost_usd: 0.035 });
    assert.equal(body.coverage.metric_scope, 'event_usage');
    assert.equal(body.coverage.matching_events, 6);
    assert.equal(body.coverage.usage_events, 5);
    assert.equal(body.coverage.missing_usage_events, 1);
    assert.equal(body.coverage.matching_sessions, 4);
    assert.equal(body.coverage.usage_sessions, 4);
    assert.deepEqual(
      body.coverage.source_breakdown.map(row => [row.source, row.event_count, row.usage_event_count]),
      [
        ['api', 2, 2],
        ['import', 2, 2],
        ['otel', 2, 1],
      ],
    );
  });

  test('supports project and agent filters over usage-bearing events', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/summary?project=alpha&agent=codex`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_sessions: number;
      coverage: { matching_events: number; usage_events: number };
    };

    assert.equal(body.total_cost_usd, 0.02);
    assert.equal(body.total_input_tokens, 1500);
    assert.equal(body.total_output_tokens, 300);
    assert.equal(body.total_sessions, 1);
    assert.equal(body.coverage.matching_events, 1);
    assert.equal(body.coverage.usage_events, 1);
  });

  test('counts deprecated models without pricing rates as unknown pricing coverage', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/summary?project=legacy`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      total_usage_events: number;
      pricing_known_events: number;
      pricing_unknown_events: number;
      unknown_model_events: number;
      estimated_cache_savings_usd: number;
    };

    assert.equal(body.total_usage_events, 1);
    assert.equal(body.pricing_known_events, 0);
    assert.equal(body.pricing_unknown_events, 1);
    assert.equal(body.unknown_model_events, 0);
    assert.equal(body.estimated_cache_savings_usd, 0);
  });

  test('returns prior-period cost comparison for the immediately preceding same-length range', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/summary?date_from=2026-04-02&date_to=2026-04-03`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      total_cost_usd: number;
      prior_total_cost_usd: number;
      cost_delta_pct: number;
    };

    assert.equal(body.total_cost_usd, 0.065);
    assert.equal(body.prior_total_cost_usd, 0.02);
    assert.equal(body.cost_delta_pct, 225);
  });

  test('filters summary by model, provider, and tier classification', async () => {
    const modelRes = await fetch(`${baseUrl}/api/v2/usage/summary?model=gpt-5.4`);
    assert.equal(modelRes.status, 200);
    const modelBody = await modelRes.json() as { total_cost_usd: number; total_usage_events: number; total_sessions: number };
    assert.equal(modelBody.total_cost_usd, 0.05);
    assert.equal(modelBody.total_usage_events, 2);
    assert.equal(modelBody.total_sessions, 2);

    const tierRes = await fetch(`${baseUrl}/api/v2/usage/summary?provider=anthropic&tier=sonnet`);
    assert.equal(tierRes.status, 200);
    const tierBody = await tierRes.json() as { total_cost_usd: number; total_usage_events: number; total_sessions: number };
    assert.equal(tierBody.total_cost_usd, 0.02);
    assert.equal(tierBody.total_usage_events, 2);
    assert.equal(tierBody.total_sessions, 1);
  });
});

describe('GET /api/v2/usage/daily', () => {
  test('returns a day-by-day series across the requested range', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/daily?date_from=2026-04-01&date_to=2026-04-03`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      data: Array<{ date: string; cost_usd: number; input_tokens: number; output_tokens: number; usage_events: number }>;
    };

    assert.deepEqual(body.data.map(row => row.date), ['2026-04-01', '2026-04-02', '2026-04-03']);
    assert.deepEqual(
      body.data.map(row => [row.date, row.cost_usd, row.input_tokens, row.output_tokens, row.usage_events]),
      [
        ['2026-04-01', 0.02, 1600, 300, 2],
        ['2026-04-02', 0.03, 2000, 500, 1],
        ['2026-04-03', 0.035, 1800, 350, 2],
      ],
    );
  });
});

describe('GET /api/v2/usage/projects and /models', () => {
  test('returns attribution rows grouped by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/projects`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      data: Array<{ project: string; cost_usd: number; session_count: number; usage_events: number }>;
    };

    assert.deepEqual(
      body.data.map(row => [row.project, row.cost_usd, row.session_count, row.usage_events]),
      [
        ['alpha', 0.04, 2, 3],
        ['beta', 0.03, 1, 1],
        ['gamma', 0.015, 1, 1],
        ['legacy', 0.005, 1, 1],
      ],
    );
  });

  test('returns attribution rows grouped by model', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/models`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      data: Array<{
        model: string;
        cost_usd: number;
        input_tokens: number;
        output_tokens: number;
        canonical_model: string;
        provider: string;
        family: string;
        tier: string;
        known: boolean;
        deprecated: boolean;
        pricing_status: string;
      }>;
    };

    assert.deepEqual(
      body.data.map(row => [row.model, row.cost_usd, row.input_tokens, row.output_tokens, row.tier, row.pricing_status]),
      [
        ['gpt-5.4', 0.05, 3500, 800, 'standard', 'known'],
        ['claude-sonnet-4-5-20250929', 0.02, 1600, 300, 'sonnet', 'known'],
        ['unknown-expensive-model', 0.015, 300, 50, 'unknown', 'unknown'],
        ['claude-3-opus-20240229', 0.005, 100, 10, 'opus', 'deprecated'],
      ],
    );
  });
});

describe('GET /api/v2/usage/tiers', () => {
  test('returns provider-neutral tier rollups with unknown model counts', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/tiers`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      data: Array<{
        provider: string;
        tier: string;
        cost_usd: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        usage_events: number;
        session_count: number;
        unknown_model_events: number;
      }>;
    };

    assert.deepEqual(
      body.data.map(row => [row.provider, row.tier, row.cost_usd, row.usage_events, row.session_count, row.unknown_model_events]),
      [
        ['openai', 'standard', 0.05, 2, 2, 0],
        ['anthropic', 'sonnet', 0.02, 2, 1, 0],
        ['unknown', 'unknown', 0.015, 1, 1, 1],
        ['anthropic', 'opus', 0.005, 1, 1, 0],
      ],
    );
  });
});

describe('GET /api/v2/usage/top-sessions', () => {
  test('returns highest-cost sessions with browsing-session metadata when available', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/top-sessions?limit=4`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      data: Array<{
        id: string;
        project: string | null;
        agent: string;
        cost_usd: number;
        input_tokens: number;
        output_tokens: number;
        browsing_session_available: boolean;
        primary_model: string;
        primary_tier: string;
        primary_provider: string;
        model_count: number;
        event_count: number;
        usage_events: number;
        tier_costs: Array<{ provider: string; tier: string; cost_usd: number; usage_events: number }>;
        unknown_model_events: number;
      }>;
    };

    assert.deepEqual(body.data.map(row => row.id), [
      'usage-sess-002',
      'usage-sess-003',
      'usage-sess-001',
      'usage-sess-004',
    ]);
    assert.equal(body.data[0]?.project, 'beta');
    assert.equal(body.data[0]?.agent, 'codex');
    assert.equal(body.data[0]?.cost_usd, 0.03);
    assert.equal(body.data[0]?.input_tokens, 2000);
    assert.equal(body.data[0]?.output_tokens, 500);
    assert.equal(body.data[0]?.primary_model, 'gpt-5.4');
    assert.equal(body.data[0]?.primary_tier, 'standard');
    assert.equal(body.data[0]?.primary_provider, 'openai');
    assert.equal(body.data[0]?.model_count, 1);
    assert.equal(body.data[0]?.event_count, 2);
    assert.equal(body.data[0]?.usage_events, 1);
    assert.deepEqual(body.data[0]?.tier_costs, [
      { provider: 'openai', tier: 'standard', cost_usd: 0.03, usage_events: 1 },
    ]);
    assert.equal(body.data[0]?.unknown_model_events, 0);
    assert.equal(typeof body.data[0]?.browsing_session_available, 'boolean');
    assert.equal(body.data[2]?.browsing_session_available, true);
    assert.equal(body.data[3]?.primary_provider, 'unknown');
    assert.equal(body.data[3]?.unknown_model_events, 1);
  });

  test('falls back to session project when usage event project is blank', async () => {
    const { insertEvent } = await import('../src/db/queries.js');
    const { getDb } = await import('../src/db/connection.js');
    const db = getDb();
    const eventId = 'usage-event-blank-project-fallback';

    try {
      insertEvent({
        event_id: eventId,
        session_id: 'usage-sess-001',
        agent_type: 'codex',
        event_type: 'assistant',
        status: 'success',
        project: '',
        model: 'gpt-5.4',
        tokens_in: 100,
        tokens_out: 20,
        cost_usd: 0.001,
        client_timestamp: '2026-04-05T12:00:00Z',
        source: 'api',
      });

      const res = await fetch(`${baseUrl}/api/v2/usage/top-sessions?date_from=2026-04-05&date_to=2026-04-05&limit=1`);
      assert.equal(res.status, 200);

      const body = await res.json() as {
        data: Array<{ id: string; project: string | null; event_count: number; usage_events: number }>;
      };

      assert.deepEqual(
        body.data.map(row => [row.id, row.project, row.event_count, row.usage_events]),
        [['usage-sess-001', 'alpha', 1, 1]],
      );
    } finally {
      db.prepare('DELETE FROM events WHERE event_id = ?').run(eventId);
    }
  });
});

describe('usage classification filters across panels', () => {
  test('applies provider and tier filters consistently to every usage panel', async () => {
    const query = 'date_from=2026-04-01&date_to=2026-04-03&provider=anthropic&tier=sonnet';
    const [dailyRes, projectsRes, modelsRes, tiersRes, agentsRes, sessionsRes] = await Promise.all([
      fetch(`${baseUrl}/api/v2/usage/daily?${query}`),
      fetch(`${baseUrl}/api/v2/usage/projects?${query}`),
      fetch(`${baseUrl}/api/v2/usage/models?${query}`),
      fetch(`${baseUrl}/api/v2/usage/tiers?${query}`),
      fetch(`${baseUrl}/api/v2/usage/agents?${query}`),
      fetch(`${baseUrl}/api/v2/usage/top-sessions?${query}`),
    ]);

    for (const res of [dailyRes, projectsRes, modelsRes, tiersRes, agentsRes, sessionsRes]) {
      assert.equal(res.status, 200);
    }

    const daily = await dailyRes.json() as { data: Array<{ date: string; cost_usd: number; usage_events: number }> };
    const projects = await projectsRes.json() as { data: Array<{ project: string; cost_usd: number; usage_events: number }> };
    const models = await modelsRes.json() as { data: Array<{ model: string; provider: string; tier: string; cost_usd: number; usage_events: number }> };
    const tiers = await tiersRes.json() as { data: Array<{ provider: string; tier: string; cost_usd: number; usage_events: number }> };
    const agents = await agentsRes.json() as { data: Array<{ agent: string; cost_usd: number; usage_events: number }> };
    const sessions = await sessionsRes.json() as { data: Array<{ id: string; cost_usd: number; primary_provider: string; primary_tier: string; usage_events: number }> };

    assert.deepEqual(
      daily.data.map(row => [row.date, row.cost_usd, row.usage_events]),
      [
        ['2026-04-01', 0.02, 2],
        ['2026-04-02', 0, 0],
        ['2026-04-03', 0, 0],
      ],
    );
    assert.deepEqual(projects.data.map(row => [row.project, row.cost_usd, row.usage_events]), [['alpha', 0.02, 2]]);
    assert.deepEqual(
      models.data.map(row => [row.model, row.provider, row.tier, row.cost_usd, row.usage_events]),
      [['claude-sonnet-4-5-20250929', 'anthropic', 'sonnet', 0.02, 2]],
    );
    assert.deepEqual(tiers.data.map(row => [row.provider, row.tier, row.cost_usd, row.usage_events]), [['anthropic', 'sonnet', 0.02, 2]]);
    assert.deepEqual(agents.data.map(row => [row.agent, row.cost_usd, row.usage_events]), [['claude_code', 0.02, 2]]);
    assert.deepEqual(sessions.data.map(row => [row.id, row.cost_usd, row.primary_provider, row.primary_tier, row.usage_events]), [
      ['usage-sess-001', 0.02, 'anthropic', 'sonnet', 2],
    ]);
  });
});

describe('Codex usage source reconciliation', () => {
  test('treats imported Codex session usage as authoritative over overlapping OTEL usage', async () => {
    const { insertEvent } = await import('../src/db/queries.js');
    const { getDb } = await import('../src/db/connection.js');
    const db = getDb();
    const eventIds = [
      'usage-reconcile-import',
      'usage-reconcile-otel-duplicate',
      'usage-reconcile-otel-after-import',
      'usage-reconcile-otel-live-only',
    ];

    try {
      insertEvent({
        event_id: eventIds[0],
        session_id: 'usage-reconcile-overlap',
        agent_type: 'codex',
        event_type: 'llm_response',
        status: 'success',
        project: 'reconcile',
        model: 'gpt-5.4',
        tokens_in: 1000,
        tokens_out: 100,
        cache_read_tokens: 200,
        cost_usd: 10,
        client_timestamp: '2026-05-01T10:02:00Z',
        source: 'import',
        metadata: {},
      });
      insertEvent({
        event_id: eventIds[1],
        session_id: 'usage-reconcile-overlap',
        agent_type: 'codex',
        event_type: 'llm_response',
        status: 'success',
        project: 'reconcile',
        model: 'gpt-5.4',
        tokens_in: 900,
        tokens_out: 90,
        cache_read_tokens: 180,
        cost_usd: 9,
        client_timestamp: '2026-05-01T10:01:00Z',
        source: 'otel',
        metadata: {},
      });
      insertEvent({
        event_id: eventIds[2],
        session_id: 'usage-reconcile-overlap',
        agent_type: 'codex',
        event_type: 'llm_response',
        status: 'success',
        project: 'reconcile',
        model: 'gpt-5.4',
        tokens_in: 400,
        tokens_out: 40,
        cache_read_tokens: 40,
        cost_usd: 4,
        client_timestamp: '2026-05-01T10:03:00Z',
        source: 'otel',
        metadata: {},
      });
      insertEvent({
        event_id: eventIds[3],
        session_id: 'usage-reconcile-live-only',
        agent_type: 'codex',
        event_type: 'llm_response',
        status: 'success',
        project: 'reconcile',
        model: 'gpt-5.4',
        tokens_in: 300,
        tokens_out: 30,
        cache_read_tokens: 30,
        cost_usd: 3,
        client_timestamp: '2026-05-01T10:04:00Z',
        source: 'otel',
        metadata: {},
      });

      const res = await fetch(`${baseUrl}/api/v2/usage/summary?date_from=2026-05-01&date_to=2026-05-01&agent=codex`);
      assert.equal(res.status, 200);

      const body = await res.json() as {
        total_cost_usd: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_read_tokens: number;
        total_usage_events: number;
        total_sessions: number;
        coverage: {
          matching_events: number;
          usage_events: number;
          source_breakdown: Array<{ source: string; event_count: number; usage_event_count: number }>;
        };
      };

      assert.equal(body.total_cost_usd, 17);
      assert.equal(body.total_input_tokens, 1700);
      assert.equal(body.total_output_tokens, 170);
      assert.equal(body.total_cache_read_tokens, 270);
      assert.equal(body.total_usage_events, 3);
      assert.equal(body.total_sessions, 2);
      assert.equal(body.coverage.matching_events, 3);
      assert.equal(body.coverage.usage_events, 3);
      assert.deepEqual(
        body.coverage.source_breakdown.map(row => [row.source, row.event_count, row.usage_event_count]),
        [
          ['import', 1, 1],
          ['otel', 2, 2],
        ],
      );
    } finally {
      const placeholders = eventIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM events WHERE event_id IN (${placeholders})`).run(...eventIds);
      db.prepare("DELETE FROM sessions WHERE id IN ('usage-reconcile-overlap', 'usage-reconcile-live-only')").run();
      db.prepare("DELETE FROM agents WHERE id = 'codex-default' AND NOT EXISTS (SELECT 1 FROM sessions WHERE agent_id = 'codex-default')").run();
    }
  });
});
