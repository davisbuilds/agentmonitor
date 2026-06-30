import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';
import type {
  backfillSessionTraceSummaries as backfillType,
  sessionTraceId as sessionTraceIdType,
} from '../src/trace-quality/summary.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let backfillSessionTraceSummaries: typeof backfillType;
let sessionTraceId: typeof sessionTraceIdType;
let server: Server;
let baseUrl = '';

async function getJson<T>(pathName: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`);
  if (response.status !== 200) {
    assert.equal(response.status, 200, await response.text());
  }
  return response.json() as Promise<T>;
}

/**
 * Source rows (events) for the lean trace-quality view: `/traces`,
 * `/traces/:id`, and `/traces/:id/observations` read `session_trace_summary` +
 * project on-demand, so they need real source data. (Scores/findings/prompts and
 * the persisted warehouse were removed in the reframe — Phase 3.)
 */
function seedLeanSessions(): void {
  const db = getDb();
  const event = db.prepare(`
    INSERT INTO events (id, event_id, session_id, agent_type, event_type, tool_name, status, model,
      project, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // s-lean-1 (project alpha): 2 observations, 1 error, 100/50 tokens, $0.25.
  event.run(501, 'le1', 's-lean-1', 'codex', 'llm_response', null, 'success', 'gpt-5', 'alpha', 100, 50, 10, 0, 0.25, 20000, '2026-06-07T10:00:10Z');
  event.run(502, 'le2', 's-lean-1', 'codex', 'tool_use', 'Read', 'error', 'gpt-5', 'alpha', 0, 0, 0, 0, 0, 4000, '2026-06-07T10:00:31Z');
  // s-lean-2 (project beta): single observation.
  event.run(503, 'le3', 's-lean-2', 'claude', 'llm_response', null, 'success', 'claude-opus-4-8', 'beta', 10, 5, 0, 0, 0.01, 1000, '2026-06-07T09:00:00Z');
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-trace-quality-api-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const summaryModule = await import('../src/trace-quality/summary.js');
  const { createApp } = await import('../src/app.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  backfillSessionTraceSummaries = summaryModule.backfillSessionTraceSummaries;
  sessionTraceId = summaryModule.sessionTraceId;

  initSchema();
  seedLeanSessions();
  backfillSessionTraceSummaries();

  server = createApp({ serveStatic: false }).listen(0);
  await once(server, 'listening');
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('lean trace list returns one row per session from the summary, keyed by a stable trace_id', async () => {
  const body = await getJson<{
    data: Array<{ id: string; session_id: string; project: string | null; aggregate: { observation_count: number; total_tokens_in: number; total_cost_usd: number } }>;
    total: number;
    coverage: {
      matching_traces: number;
      included_traces: number;
      observations_with_usage: number;
      observations_missing_usage: number;
      score_coverage: { scored_traces: number; total_scores: number };
    };
  }>('/api/v2/trace-quality/traces');

  // One row per event-bearing session (NOT one per event/observation).
  assert.equal(body.total, 2);
  assert.deepEqual(
    [...body.data].map(t => t.session_id).sort(),
    ['s-lean-1', 's-lean-2'],
  );
  for (const trace of body.data) {
    assert.equal(trace.id, sessionTraceId(trace.session_id));
  }
  const leanOne = body.data.find(t => t.session_id === 's-lean-1');
  assert.equal(leanOne?.aggregate.observation_count, 2);
  assert.equal(leanOne?.aggregate.total_tokens_in, 100);
  assert.equal(leanOne?.aggregate.total_cost_usd, 0.25);
  // Lean view carries no scores.
  assert.equal(body.coverage.score_coverage.scored_traces, 0);
  assert.equal(body.coverage.score_coverage.total_scores, 0);
});

test('lean trace list honors the project filter (parity)', async () => {
  const body = await getJson<{ data: Array<{ session_id: string }>; total: number }>(
    '/api/v2/trace-quality/traces?project=alpha',
  );
  assert.equal(body.total, 1);
  assert.deepEqual(body.data.map(t => t.session_id), ['s-lean-1']);
});

test('lean trace list filters by session_id for drill-in scoping', async () => {
  const scoped = await getJson<{ data: Array<{ id: string; session_id: string }>; total: number }>(
    '/api/v2/trace-quality/traces?session_id=s-lean-1',
  );
  assert.equal(scoped.total, 1);
  assert.equal(scoped.data[0]?.id, sessionTraceId('s-lean-1'));
  assert.ok(scoped.data.every(trace => trace.session_id === 's-lean-1'));

  const empty = await getJson<{ data: unknown[]; total: number }>(
    '/api/v2/trace-quality/traces?session_id=session-does-not-exist',
  );
  assert.equal(empty.total, 0);
});

test('lean trace detail is summary-backed (aggregate totals; no persisted prompts/scores)', async () => {
  const traceId = sessionTraceId('s-lean-1');
  const body = await getJson<{
    trace: {
      id: string;
      session_id: string;
      aggregate: { observation_count: number; error_count: number; total_tokens_out: number };
      prompt_refs: unknown[];
      score_summary: unknown[];
    };
    coverage: { included_traces: number };
  }>(`/api/v2/trace-quality/traces/${traceId}`);

  assert.equal(body.trace.id, traceId);
  assert.equal(body.trace.session_id, 's-lean-1');
  assert.equal(body.trace.aggregate.observation_count, 2);
  assert.equal(body.trace.aggregate.error_count, 1);
  assert.equal(body.trace.aggregate.total_tokens_out, 50);
  assert.deepEqual(body.trace.prompt_refs, []);
  assert.deepEqual(body.trace.score_summary, []);
  assert.equal(body.coverage.included_traces, 1);

  const missing = await fetch(`${baseUrl}/api/v2/trace-quality/traces/sts:not-a-real-trace`);
  assert.equal(missing.status, 404);
});

test('lean trace observations are projected on-demand under one session trace', async () => {
  const traceId = sessionTraceId('s-lean-1');
  const body = await getJson<{
    data: Array<{ id: string; trace_id: string; parent_observation_id: string | null; started_at: string | null }>;
    tree: Array<{ id: string; children: Array<{ id: string }> }>;
    total: number;
  }>(`/api/v2/trace-quality/traces/${traceId}/observations?limit=10`);

  // Every event surfaces as an observation, all under the single session trace.
  assert.equal(body.total, 2);
  assert.ok(body.data.every(o => o.trace_id === traceId), 'all observations hang under the session trace');
  assert.equal(new Set(body.data.map(o => o.trace_id)).size, 1);
  // Flat event observations are deterministically ordered (by start time) roots.
  assert.equal(body.tree.length, 2);
  assert.equal(body.data[0]?.started_at, '2026-06-07T10:00:10Z');
  assert.equal(body.data[1]?.started_at, '2026-06-07T10:00:31Z');
});
