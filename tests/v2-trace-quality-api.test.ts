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

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let server: Server;
let baseUrl = '';

async function getJson<T>(pathName: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`);
  if (response.status !== 200) {
    assert.equal(response.status, 200, await response.text());
  }
  return response.json() as Promise<T>;
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
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trace', 'trace-high', 'correctness', 'numeric', 0.92, null, null, null, 'human', 'reviewer', 'Looks good', '{}',
    'observation', 'obs-child', 'tool_error', 'boolean', null, null, 1, null, 'system', 'detector', 'Tool failed', '{}',
    'trace', 'trace-low', 'correctness', 'numeric', 0.35, null, null, null, 'llm_judge', 'judge', 'Low confidence', '{}',
  );
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-trace-quality-api-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();
  seedTraceQualityData();

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

test('trace list applies filters, pagination, and coverage accounting', async () => {
  const body = await getJson<{
    data: Array<{ id: string; aggregate: { total_tokens_in: number; total_cost_usd: number } }>;
    total: number;
    coverage: {
      matching_traces: number;
      included_traces: number;
      excluded_low_coverage_traces: number;
      observations_with_usage: number;
      observations_missing_usage: number;
      score_coverage: { scored_traces: number; total_scores: number };
    };
  }>(
    '/api/v2/trace-quality/traces?project=alpha&observation_type=generation&model=gpt-5'
      + '&score_name=correctness&min_score=0.8&exclude_low_coverage=true&limit=1',
  );

  assert.equal(body.total, 1);
  assert.deepEqual(body.data.map(trace => trace.id), ['trace-high']);
  assert.equal(body.data[0]?.aggregate.total_tokens_in, 100);
  assert.equal(body.data[0]?.aggregate.total_cost_usd, 0.25);
  assert.equal(body.coverage.matching_traces, 1);
  assert.equal(body.coverage.included_traces, 1);
  assert.equal(body.coverage.excluded_low_coverage_traces, 0);
  assert.equal(body.coverage.observations_with_usage, 1);
  assert.equal(body.coverage.observations_missing_usage, 1);
  assert.equal(body.coverage.score_coverage.scored_traces, 1);
  assert.equal(body.coverage.score_coverage.total_scores, 2);
});

test('trace detail returns parsed metadata, aggregate totals, prompts, and score summary', async () => {
  const body = await getJson<{
    trace: {
      id: string;
      metadata: Record<string, unknown>;
      tags: string[];
      coverage: Record<string, unknown>;
      aggregate: { observation_count: number; error_count: number; total_tokens_out: number };
      prompt_refs: Array<{ name: string; version: string | null; observation_count: number }>;
      score_summary: Array<{ name: string; count: number; numeric_avg: number | null }>;
    };
    coverage: { included_traces: number };
  }>('/api/v2/trace-quality/traces/trace-high');

  assert.equal(body.trace.id, 'trace-high');
  assert.equal(body.trace.metadata.source_table, 'events');
  assert.deepEqual(body.trace.tags, ['api', 'quality']);
  assert.equal(body.trace.coverage.has_prompt_refs, true);
  assert.equal(body.trace.aggregate.observation_count, 2);
  assert.equal(body.trace.aggregate.error_count, 1);
  assert.equal(body.trace.aggregate.total_tokens_out, 50);
  assert.deepEqual(body.trace.prompt_refs.map(prompt => [prompt.name, prompt.version, prompt.observation_count]), [
    ['agentmonitor-system', '2026-06-07', 1],
  ]);
  assert.deepEqual(body.trace.score_summary.map(score => [score.name, score.count, score.numeric_avg]), [
    ['correctness', 1, 0.92],
    ['tool_error', 1, null],
  ]);
  assert.equal(body.coverage.included_traces, 1);
});

test('trace observations return flat deterministic ordering and a nested tree', async () => {
  const body = await getJson<{
    data: Array<{ id: string; parent_observation_id: string | null; metadata: Record<string, unknown> }>;
    tree: Array<{ id: string; children: Array<{ id: string }> }>;
    total: number;
    coverage: { observations_with_usage: number; observations_missing_usage: number };
  }>('/api/v2/trace-quality/traces/trace-high/observations?limit=10');

  assert.equal(body.total, 2);
  assert.deepEqual(body.data.map(observation => observation.id), ['obs-root', 'obs-child']);
  assert.equal(body.data[1]?.metadata.source_table, 'session_items');
  assert.equal(body.tree[0]?.id, 'obs-root');
  assert.deepEqual(body.tree[0]?.children.map(child => child.id), ['obs-child']);
  assert.equal(body.coverage.observations_with_usage, 1);
  assert.equal(body.coverage.observations_missing_usage, 1);
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
    data: Array<{ name: string; target_type: string; target_id: string; numeric_value: number | null }>;
    total: number;
    coverage: { score_coverage: { total_scores: number; scored_traces: number } };
  }>('/api/v2/trace-quality/scores?name=correctness&limit=10');
  assert.equal(scores.total, 2);
  assert.deepEqual(scores.data.map(score => [score.target_type, score.target_id, score.numeric_value]), [
    ['trace', 'trace-high', 0.92],
    ['trace', 'trace-low', 0.35],
  ]);
  assert.equal(scores.coverage.score_coverage.total_scores, 3);
  assert.equal(scores.coverage.score_coverage.scored_traces, 2);

  const summary = await getJson<{
    data: Array<{ name: string; count: number; numeric_avg: number | null; boolean_true: number }>;
    coverage: { included_traces: number };
  }>('/api/v2/trace-quality/score-summary');
  assert.deepEqual(summary.data.map(row => [row.name, row.count, row.numeric_avg, row.boolean_true]), [
    ['correctness', 2, 0.635, 0],
    ['tool_error', 1, null, 1],
  ]);
  assert.equal(summary.coverage.included_traces, 2);

  const prompts = await getJson<{
    data: Array<{ name: string; version: string | null; observation_count: number; trace_count: number }>;
    coverage: { included_traces: number };
  }>('/api/v2/trace-quality/prompts');
  assert.deepEqual(prompts.data.map(prompt => [prompt.name, prompt.version, prompt.observation_count, prompt.trace_count]), [
    ['agentmonitor-system', '2026-06-07', 1, 1],
  ]);
  assert.equal(prompts.coverage.included_traces, 2);

  const findings = await getJson<{
    data: Array<{ kind: string; severity: string; trace_id: string; observation_id: string | null }>;
    coverage: { matching_traces: number };
  }>('/api/v2/trace-quality/findings?limit=10');
  assert.deepEqual(findings.data.map(finding => [finding.kind, finding.severity, finding.trace_id, finding.observation_id]), [
    ['observation_error', 'error', 'trace-high', 'obs-child'],
    ['low_score', 'warning', 'trace-low', null],
    ['low_coverage', 'warning', 'trace-low', null],
  ]);
  assert.equal(findings.coverage.matching_traces, 2);
});
