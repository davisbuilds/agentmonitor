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

async function sendJson<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  pathName: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

function seedTraceQualityData(): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO trace_quality_traces (
      id, session_id, browsing_session_id, source_trace_id, agent_type, name, status,
      project, branch, started_at, ended_at, duration_ms, metadata_json, tags_json, coverage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trace-high',
    'session-high',
    'browse-high',
    'source-high',
    'codex',
    'High quality trace',
    'success',
    'alpha',
    'main',
    '2026-06-07T10:00:00Z',
    '2026-06-07T10:01:00Z',
    60000,
    '{"source_table":"events"}',
    '["api","quality"]',
    '{"projection_confidence":"high","has_full_transcript":true,"has_token_usage":true,"has_cost":true,"has_prompt_refs":true}',
  );

  db.prepare(`
    INSERT INTO trace_quality_traces (
      id, session_id, browsing_session_id, source_trace_id, agent_type, name, status,
      project, branch, started_at, ended_at, duration_ms, metadata_json, tags_json, coverage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trace-low',
    'session-low',
    'browse-low',
    'source-low',
    'claude_code',
    'Low coverage trace',
    'success',
    'alpha',
    'main',
    '2026-06-07T11:00:00Z',
    '2026-06-07T11:00:30Z',
    30000,
    '{}',
    '["summary"]',
    '{"projection_confidence":"low","has_full_transcript":false,"has_token_usage":false}',
  );

  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, parent_observation_id, session_id, source_kind, source_id, source_item_id,
      observation_type, name, status, severity, model, tool_name, started_at, ended_at,
      duration_ms, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd,
      input_hash, output_hash, input_summary, output_summary, payload_policy, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-root',
    'trace-high',
    null,
    'session-high',
    'event',
    '100',
    'evt-root',
    'generation',
    'Assistant response',
    'success',
    'info',
    'gpt-5',
    null,
    '2026-06-07T10:00:10Z',
    '2026-06-07T10:00:30Z',
    20000,
    100,
    50,
    10,
    0,
    0.25,
    'input-hash',
    'output-hash',
    'Prompt summary',
    'Response summary',
    'summary_only',
    '{"source_table":"events","source_id":100}',
  );

  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, parent_observation_id, session_id, source_kind, source_id, source_item_id,
      observation_type, name, status, severity, model, tool_name, started_at, ended_at,
      duration_ms, payload_policy, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-child',
    'trace-high',
    'obs-root',
    'session-high',
    'session_item',
    '101',
    'toolu-1',
    'tool',
    'Read',
    'error',
    'error',
    null,
    'Read',
    '2026-06-07T10:00:31Z',
    '2026-06-07T10:00:35Z',
    4000,
    'source_ref',
    '{"source_table":"session_items","source_id":101}',
  );

  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, session_id, source_kind, source_id, observation_type,
      name, status, started_at, payload_policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-low',
    'trace-low',
    'session-low',
    'browsing_session',
    'browse-low',
    'event',
    'Summary only event',
    'success',
    '2026-06-07T11:00:05Z',
    'summary_only',
  );

  const promptId = Number(db.prepare(`
    INSERT INTO trace_quality_prompt_refs (
      name, version, label, source, content_hash, file_path, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'agentmonitor-system',
    '2026-06-07',
    'prod',
    'file',
    'prompt-hash',
    '/tmp/prompts/system.md',
    '{"owner":"agentmonitor"}',
  ).lastInsertRowid);

  db.prepare(`
    INSERT INTO trace_quality_observation_prompts (observation_id, prompt_ref_id)
    VALUES (?, ?)
  `).run('obs-root', promptId);

  db.prepare(`
    INSERT INTO trace_quality_scores (
      target_type, target_id, name, value_type, numeric_value, categorical_value,
      boolean_value, text_value, source, evaluator_name, comment, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trace', 'trace-high', 'correctness', 'numeric', 0.92, null, null, null, 'human', 'reviewer', 'Looks good', '{}',
    'trace', 'trace-high', 'correctness', 'categorical', null, 'pass', null, null, 'human', 'reviewer', 'Category pass', '{}',
    'observation', 'obs-child', 'tool_error', 'boolean', null, null, 1, null, 'system', 'detector', 'Tool failed', '{}',
    'trace', 'trace-low', 'correctness', 'numeric', 0.35, null, null, null, 'llm_judge', 'judge', 'Low confidence', '{}',
  );
}

/**
 * Source rows (events) for the lean view (reframe Phase 2): the `/traces`,
 * `/traces/:id`, and `/traces/:id/observations` endpoints now read
 * `session_trace_summary` + project on-demand, so they need real source data —
 * not the persisted `trace_quality_*` rows the unchanged scores/findings/prompts
 * endpoints still use. These sessions are isolated from the persisted seed.
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
  seedTraceQualityData();
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

test('observation detail exposes scores and prompt refs', async () => {
  const body = await getJson<{
    observation: { id: string; trace_id: string; prompt_refs: Array<{ name: string }>; scores: Array<{ name: string }> };
  }>('/api/v2/trace-quality/observations/obs-root');

  assert.equal(body.observation.id, 'obs-root');
  assert.equal(body.observation.trace_id, 'trace-high');
  assert.deepEqual(body.observation.prompt_refs.map(prompt => prompt.name), ['agentmonitor-system']);
  assert.deepEqual(body.observation.scores, []);
});

test('scores, score summaries, prompts, and findings return stable rollups', async () => {
  const scores = await getJson<{
    data: Array<{ name: string; target_type: string; target_id: string; value_type: string; numeric_value: number | null; categorical_value: string | null }>;
    total: number;
    coverage: { score_coverage: { total_scores: number; scored_traces: number } };
  }>('/api/v2/trace-quality/scores?name=correctness&limit=10');
  assert.equal(scores.total, 3);
  assert.deepEqual(scores.data.map(score => [score.target_type, score.target_id, score.value_type, score.numeric_value, score.categorical_value]), [
    ['trace', 'trace-high', 'numeric', 0.92, null],
    ['trace', 'trace-high', 'categorical', null, 'pass'],
    ['trace', 'trace-low', 'numeric', 0.35, null],
  ]);
  assert.equal(scores.coverage.score_coverage.total_scores, 4);
  assert.equal(scores.coverage.score_coverage.scored_traces, 2);

  const summary = await getJson<{
    data: Array<{ name: string; value_type: string; count: number; numeric_avg: number | null; boolean_true: number; categorical_values: Record<string, number> }>;
    coverage: { included_traces: number };
  }>('/api/v2/trace-quality/score-summary');
  assert.deepEqual(summary.data.map(row => [row.name, row.value_type, row.count, row.numeric_avg, row.boolean_true, row.categorical_values]), [
    ['correctness', 'categorical', 1, null, 0, { pass: 1 }],
    ['correctness', 'numeric', 2, 0.635, 0, {}],
    ['tool_error', 'boolean', 1, null, 1, {}],
  ]);
  assert.equal(summary.coverage.included_traces, 2);

  const prompts = await getJson<{
    data: Array<{
      name: string;
      version: string | null;
      observation_count: number;
      trace_count: number;
      generation_count: number;
      median_duration_ms: number | null;
      total_cost_usd: number;
      total_tokens_in: number;
      total_tokens_out: number;
      score_count: number;
      median_numeric_score: number | null;
      last_seen: string | null;
    }>;
    coverage: { included_traces: number };
  }>('/api/v2/trace-quality/prompts');
  assert.deepEqual(prompts.data.map(prompt => [
    prompt.name,
    prompt.version,
    prompt.observation_count,
    prompt.trace_count,
    prompt.generation_count,
    prompt.median_duration_ms,
    prompt.total_cost_usd,
    prompt.total_tokens_in,
    prompt.total_tokens_out,
    prompt.score_count,
    prompt.median_numeric_score,
    prompt.last_seen,
  ]), [
    ['agentmonitor-system', '2026-06-07', 1, 1, 1, 20000, 0.25, 100, 50, 2, 0.92, '2026-06-07T10:00:10Z'],
  ]);
  assert.equal(prompts.coverage.included_traces, 2);

  const findings = await getJson<{
    data: Array<{ kind: string; severity: string; trace_id: string; observation_id: string | null }>;
    coverage: { matching_traces: number };
  }>('/api/v2/trace-quality/findings?limit=10');
  assert.deepEqual(findings.data.map(finding => [finding.kind, finding.severity, finding.trace_id, finding.observation_id]), [
    ['observation_error', 'high', 'trace-high', 'obs-child'],
    ['low_quality_score', 'warning', 'trace-low', null],
  ]);
  assert.equal(findings.coverage.matching_traces, 2);
});

test('findings can be filtered by kind and severity', async () => {
  // kind narrows to a single finding kind.
  const byKind = await getJson<{ data: Array<{ kind: string; severity: string }>; total: number }>(
    '/api/v2/trace-quality/findings?kind=observation_error&limit=10',
  );
  assert.deepEqual(byKind.data.map(finding => [finding.kind, finding.severity]), [['observation_error', 'high']]);
  assert.equal(byKind.total, 1);

  // severity narrows independently of kind.
  const bySeverity = await getJson<{ data: Array<{ kind: string; severity: string }>; total: number }>(
    '/api/v2/trace-quality/findings?severity=warning&limit=10',
  );
  assert.deepEqual(bySeverity.data.map(finding => [finding.kind, finding.severity]), [['low_quality_score', 'warning']]);
  assert.equal(bySeverity.total, 1);

  // kind + severity combine; an impossible combination returns nothing rather than erroring.
  const mismatch = await getJson<{ data: unknown[]; total: number }>(
    '/api/v2/trace-quality/findings?kind=observation_error&severity=warning',
  );
  assert.equal(mismatch.total, 0);
  assert.equal(mismatch.data.length, 0);
});

test('score rollups group local scores by trace, session, model, tool, prompt, and day', async () => {
  const db = getDb();
  const promptId = (db.prepare('SELECT id FROM trace_quality_prompt_refs WHERE name = ?')
    .get('agentmonitor-system') as { id: number }).id;
  db.prepare(`
    INSERT INTO trace_quality_scores (
      target_type, target_id, name, value_type, numeric_value, source, evaluator_name, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'observation',
    'obs-root',
    'helpfulness',
    'numeric',
    0.77,
    'human',
    'reviewer',
    '{}',
    '2026-06-07T12:00:00Z',
  );

  const helpfulness = await getJson<{
    data: {
      trace: Array<{ key: string; label: string | null; score_count: number; numeric_avg: number | null; observation_count: number }>;
      session: Array<{ key: string; score_count: number }>;
      model: Array<{ key: string; score_count: number; numeric_avg: number | null }>;
      prompt: Array<{ key: string; label: string | null; score_count: number; numeric_avg: number | null }>;
      day: Array<{ key: string; score_count: number; numeric_avg: number | null }>;
    };
    coverage: { score_coverage: { total_scores: number } };
  }>('/api/v2/trace-quality/score-rollups?score_name=helpfulness');

  assert.deepEqual(helpfulness.data.trace.map(row => [row.key, row.label, row.score_count, row.numeric_avg, row.observation_count]), [
    ['trace-high', 'High quality trace', 1, 0.77, 1],
  ]);
  assert.deepEqual(helpfulness.data.session.map(row => [row.key, row.score_count]), [
    ['session-high', 1],
  ]);
  assert.deepEqual(helpfulness.data.model.map(row => [row.key, row.score_count, row.numeric_avg]), [
    ['gpt-5', 1, 0.77],
  ]);
  assert.deepEqual(helpfulness.data.prompt.map(row => [row.key, row.label, row.score_count, row.numeric_avg]), [
    [String(promptId), 'agentmonitor-system@2026-06-07', 1, 0.77],
  ]);
  assert.deepEqual(helpfulness.data.day.map(row => [row.key, row.score_count, row.numeric_avg]), [
    ['2026-06-07', 1, 0.77],
  ]);
  assert.equal(helpfulness.coverage.score_coverage.total_scores, 4);

  const tool = await getJson<{ data: { tool: Array<{ key: string; score_count: number; boolean_true: number }> } }>(
    '/api/v2/trace-quality/score-rollups?score_name=tool_error',
  );
  assert.deepEqual(tool.data.tool.map(row => [row.key, row.score_count, row.boolean_true]), [
    ['Read', 1, 1],
  ]);

  db.prepare(`
    INSERT INTO events (
      id, event_id, session_id, agent_type, event_type, status,
      created_at, client_timestamp, metadata, model, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    100,
    'evt-source-100',
    'session-high',
    'codex',
    'llm_response',
    'success',
    '2026-06-07T10:00:10Z',
    '2026-06-07T10:00:10Z',
    '{}',
    'gpt-5',
    'api',
  );
  db.prepare(`
    INSERT INTO messages (id, session_id, ordinal, role, content, timestamp, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(200, 'session-high', 0, 'user', 'Review this trace', '2026-06-07T10:00:00Z', 17);
  db.prepare(`
    INSERT INTO session_items (
      id, session_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    101,
    'session-high',
    1,
    'toolu-1',
    'tool_call',
    'error',
    '{"tool_name":"Read"}',
    '2026-06-07T10:00:31Z',
  );
  db.prepare(`
    INSERT INTO trace_quality_scores (
      target_type, target_id, name, value_type, numeric_value, source, evaluator_name, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'event', '100', 'source_target_review', 'numeric', 0.61, 'human', 'reviewer', '{}', '2026-06-07T12:10:00Z',
    'message', '200', 'source_target_review', 'numeric', 0.62, 'human', 'reviewer', '{}', '2026-06-07T12:11:00Z',
    'session_item', '101', 'source_target_review', 'numeric', 0.63, 'human', 'reviewer', '{}', '2026-06-07T12:12:00Z',
  );

  const sourceTargets = await getJson<{
    data: {
      trace: Array<{ key: string; score_count: number; numeric_avg: number | null; observation_count: number }>;
      session: Array<{ key: string; score_count: number; numeric_avg: number | null }>;
      model: Array<{ key: string; score_count: number; numeric_avg: number | null }>;
      tool: Array<{ key: string; score_count: number; numeric_avg: number | null }>;
      prompt: Array<{ key: string; label: string | null; score_count: number; numeric_avg: number | null }>;
      day: Array<{ key: string; score_count: number; numeric_avg: number | null }>;
    };
  }>('/api/v2/trace-quality/score-rollups?score_name=source_target_review');
  assert.deepEqual(sourceTargets.data.trace.map(row => [row.key, row.score_count, row.numeric_avg, row.observation_count]), [
    ['trace-high', 2, 0.62, 2],
  ]);
  assert.deepEqual(sourceTargets.data.session.map(row => [row.key, row.score_count, row.numeric_avg]), [
    ['session-high', 3, 0.62],
  ]);
  assert.deepEqual(sourceTargets.data.model.map(row => [row.key, row.score_count, row.numeric_avg]), [
    ['gpt-5', 1, 0.61],
  ]);
  assert.deepEqual(sourceTargets.data.tool.map(row => [row.key, row.score_count, row.numeric_avg]), [
    ['Read', 1, 0.63],
  ]);
  assert.deepEqual(sourceTargets.data.prompt.map(row => [row.key, row.label, row.score_count, row.numeric_avg]), [
    [String(promptId), 'agentmonitor-system@2026-06-07', 1, 0.61],
  ]);
  assert.deepEqual(sourceTargets.data.day.map(row => [row.key, row.score_count, row.numeric_avg]), [
    ['2026-06-07', 3, 0.62],
  ]);
});

test('score write endpoints create, patch, delete, and validate local review scores', async () => {
  const created = await sendJson<{ score: { id: number; target_type: string; target_id: string; name: string; value: number; metadata: Record<string, unknown> } }>(
    'POST',
    '/api/v2/trace-quality/scores',
    {
      target_type: 'trace',
      target_id: 'trace-high',
      name: 'helpfulness',
      value_type: 'numeric',
      value: 0.88,
      source: 'human',
      evaluator_name: 'reviewer',
      comment: 'Useful trace',
      metadata: { rubric: 'manual' },
    },
  );

  assert.equal(created.status, 201);
  assert.equal(created.body.score.target_type, 'trace');
  assert.equal(created.body.score.target_id, 'trace-high');
  assert.equal(created.body.score.name, 'helpfulness');
  assert.equal(created.body.score.value, 0.88);
  assert.deepEqual(created.body.score.metadata, { rubric: 'manual' });

  const patched = await sendJson<{ score: { id: number; value_type: string; value: boolean; numeric_value: number | null; boolean_value: number | null } }>(
    'PATCH',
    `/api/v2/trace-quality/scores/${created.body.score.id}`,
    {
      value_type: 'boolean',
      value: false,
      comment: 'Changed to pass/fail review',
    },
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.score.value_type, 'boolean');
  assert.equal(patched.body.score.value, false);
  assert.equal(patched.body.score.numeric_value, null);
  assert.equal(patched.body.score.boolean_value, 0);

  const invalid = await sendJson<{ error: string }>('POST', '/api/v2/trace-quality/scores', {
    target_type: 'trace',
    target_id: 'missing-trace',
    name: 'quality',
    value_type: 'numeric',
    value: 0.5,
    source: 'human',
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Score target not found/);

  const deleted = await sendJson<{ deleted: true }>('DELETE', `/api/v2/trace-quality/scores/${created.body.score.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true });

  const missingDelete = await sendJson<{ error: string }>('DELETE', `/api/v2/trace-quality/scores/${created.body.score.id}`);
  assert.equal(missingDelete.status, 404);
  assert.match(missingDelete.body.error, /Score not found/);

  const sessionScore = await sendJson<{ score: { id: number; target_type: string; target_id: string; value: boolean } }>(
    'POST',
    '/api/v2/trace-quality/scores',
    {
      target_type: 'session',
      target_id: 'session-high',
      name: 'reviewed',
      value_type: 'boolean',
      value: true,
      source: 'human',
    },
  );
  assert.equal(sessionScore.status, 201);

  const traceScopedScores = await getJson<{
    data: Array<{ id: number; target_type: string; target_id: string; name: string; value: boolean | number | string | null }>;
  }>('/api/v2/trace-quality/scores?trace_id=trace-high');
  assert.ok(
    traceScopedScores.data.some(score =>
      score.id === sessionScore.body.score.id
      && score.target_type === 'session'
      && score.target_id === 'session-high'
      && score.name === 'reviewed'
      && score.value === true
    ),
  );
});
