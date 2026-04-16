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

    assert.equal(body.total_cost_usd, 0.07);
    assert.equal(body.total_input_tokens, 5100);
    assert.equal(body.total_output_tokens, 1100);
    assert.equal(body.total_cache_read_tokens, 400);
    assert.equal(body.total_cache_write_tokens, 100);
    assert.equal(body.total_usage_events, 4);
    assert.equal(body.total_sessions, 3);
    assert.equal(body.active_days, 3);
    assert.deepEqual(body.peak_day, { date: '2026-04-02', cost_usd: 0.03 });
    assert.equal(body.coverage.metric_scope, 'event_usage');
    assert.equal(body.coverage.matching_events, 5);
    assert.equal(body.coverage.usage_events, 4);
    assert.equal(body.coverage.missing_usage_events, 1);
    assert.equal(body.coverage.matching_sessions, 3);
    assert.equal(body.coverage.usage_sessions, 3);
    assert.deepEqual(
      body.coverage.source_breakdown.map(row => [row.source, row.event_count, row.usage_event_count]),
      [
        ['api', 1, 1],
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
        ['2026-04-03', 0.02, 1500, 300, 1],
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
      ],
    );
  });

  test('returns attribution rows grouped by model', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/models`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      data: Array<{ model: string; cost_usd: number; input_tokens: number; output_tokens: number }>;
    };

    assert.deepEqual(
      body.data.map(row => [row.model, row.cost_usd, row.input_tokens, row.output_tokens]),
      [
        ['gpt-5.4', 0.05, 3500, 800],
        ['claude-sonnet-4-5-20250929', 0.02, 1600, 300],
      ],
    );
  });
});

describe('GET /api/v2/usage/top-sessions', () => {
  test('returns highest-cost sessions with browsing-session metadata when available', async () => {
    const res = await fetch(`${baseUrl}/api/v2/usage/top-sessions?limit=3`);
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
      }>;
    };

    assert.deepEqual(body.data.map(row => row.id), [
      'usage-sess-002',
      'usage-sess-003',
      'usage-sess-001',
    ]);
    assert.equal(body.data[0]?.project, 'beta');
    assert.equal(body.data[0]?.agent, 'codex');
    assert.equal(body.data[0]?.cost_usd, 0.03);
    assert.equal(body.data[0]?.input_tokens, 2000);
    assert.equal(body.data[0]?.output_tokens, 500);
    assert.equal(typeof body.data[0]?.browsing_session_available, 'boolean');
    assert.equal(body.data[2]?.browsing_session_available, true);
  });
});
