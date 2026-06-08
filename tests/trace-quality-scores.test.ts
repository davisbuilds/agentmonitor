import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';
import type {
  createTraceQualityScore as createTraceQualityScoreType,
  deleteTraceQualityScore as deleteTraceQualityScoreType,
  runTraceQualityCodeEvaluators as runTraceQualityCodeEvaluatorsType,
  updateTraceQualityScore as updateTraceQualityScoreType,
} from '../src/trace-quality/scores.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let createTraceQualityScore: typeof createTraceQualityScoreType;
let updateTraceQualityScore: typeof updateTraceQualityScoreType;
let deleteTraceQualityScore: typeof deleteTraceQualityScoreType;
let runTraceQualityCodeEvaluators: typeof runTraceQualityCodeEvaluatorsType;

function clearTraceQualityData(): void {
  getDb().exec(`
    DELETE FROM trace_quality_scores;
    DELETE FROM trace_quality_observations;
    DELETE FROM trace_quality_traces;
    DELETE FROM browsing_sessions;
    DELETE FROM events;
    DELETE FROM messages;
    DELETE FROM session_items;
  `);
}

function seedTraceQualityGraph(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (id, project, agent, started_at, message_count, user_message_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('session-1', 'agentmonitor', 'codex', '2026-06-07T10:00:00.000Z', 1, 1);

  db.prepare(`
    INSERT INTO trace_quality_traces (
      id, session_id, agent_type, name, status, project, started_at,
      metadata_json, tags_json, coverage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trace-1',
    'session-1',
    'codex',
    'High fidelity trace',
    'success',
    'agentmonitor',
    '2026-06-07T10:00:00.000Z',
    '{}',
    '[]',
    '{"projection_confidence":"high","has_full_transcript":true,"has_token_usage":true}',
    'trace-low',
    'session-low',
    'claude_code',
    'Low fidelity trace',
    'success',
    'agentmonitor',
    '2026-06-07T11:00:00.000Z',
    '{}',
    '[]',
    '{"projection_confidence":"low","has_full_transcript":false,"has_token_usage":false}',
  );

  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, session_id, source_kind, source_id, observation_type, name, status,
      severity, model, tool_name, started_at, tokens_in, tokens_out, cost_usd, payload_policy, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-generation-costed',
    'trace-1',
    'session-1',
    'event',
    '1',
    'generation',
    'Costed generation',
    'success',
    'info',
    'gpt-5',
    null,
    '2026-06-07T10:00:01.000Z',
    100,
    50,
    0.75,
    'summary_only',
    '{}',
    'obs-generation-unpriced',
    'trace-1',
    'session-1',
    'event',
    '2',
    'generation',
    'Unpriced generation',
    'success',
    'info',
    'gpt-5',
    null,
    '2026-06-07T10:00:02.000Z',
    10,
    20,
    null,
    'summary_only',
    '{}',
    'obs-tool-ok',
    'trace-1',
    'session-1',
    'session_item',
    '3',
    'tool',
    'Read',
    'success',
    'info',
    null,
    'Read',
    '2026-06-07T10:00:03.000Z',
    0,
    0,
    null,
    'source_ref',
    '{}',
    'obs-tool-error',
    'trace-1',
    'session-1',
    'session_item',
    '4',
    'tool',
    'Bash',
    'error',
    'error',
    null,
    'Bash',
    '2026-06-07T10:00:04.000Z',
    0,
    0,
    null,
    'source_ref',
    '{"status_message":"429 rate limit"}',
  );
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-trace-quality-scores-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const scores = await import('../src/trace-quality/scores.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  createTraceQualityScore = scores.createTraceQualityScore;
  updateTraceQualityScore = scores.updateTraceQualityScore;
  deleteTraceQualityScore = scores.deleteTraceQualityScore;
  runTraceQualityCodeEvaluators = scores.runTraceQualityCodeEvaluators;

  initSchema();
});

beforeEach(() => {
  clearTraceQualityData();
  seedTraceQualityGraph();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('score validation rejects unsupported targets, missing targets, and mismatched values', () => {
  assert.throws(() => createTraceQualityScore({
    target_type: 'tool_call',
    target_id: '1',
    name: 'quality',
    value_type: 'numeric',
    value: 0.9,
    source: 'human',
  }), /Unsupported score target_type/);

  assert.throws(() => createTraceQualityScore({
    target_type: 'trace',
    target_id: 'missing-trace',
    name: 'quality',
    value_type: 'numeric',
    value: 0.9,
    source: 'human',
  }), /Score target not found/);

  assert.throws(() => createTraceQualityScore({
    target_type: 'trace',
    target_id: 'trace-1',
    name: 'quality',
    value_type: 'numeric',
    categorical_value: 'pass',
    source: 'human',
  }), /does not match value_type numeric/);

  assert.throws(() => createTraceQualityScore({
    target_type: 'trace',
    target_id: 'trace-1',
    name: 'quality',
    value_type: 'boolean',
    value: 'true',
    source: 'human',
  }), /boolean score value must be a boolean/);
});

test('valid numeric, categorical, boolean, and text scores persist with one active value column', () => {
  const numeric = createTraceQualityScore({
    target_type: 'trace',
    target_id: 'trace-1',
    name: 'quality',
    value_type: 'numeric',
    value: 0.91,
    source: 'human',
    evaluator_name: 'reviewer',
    comment: 'Looks correct',
    metadata: { rubric: 'manual' },
  });
  const categorical = createTraceQualityScore({
    target_type: 'observation',
    target_id: 'obs-tool-ok',
    name: 'tool_outcome',
    value_type: 'categorical',
    value: 'pass',
    source: 'api',
  });
  const boolean = createTraceQualityScore({
    target_type: 'session',
    target_id: 'session-1',
    name: 'approved',
    value_type: 'boolean',
    value: true,
    source: 'human',
  });
  const text = createTraceQualityScore({
    target_type: 'trace',
    target_id: 'trace-1',
    name: 'review_note',
    value_type: 'text',
    value: 'Check linked issue before release.',
    source: 'human',
  });

  assert.equal(numeric.value, 0.91);
  assert.equal(numeric.numeric_value, 0.91);
  assert.equal(numeric.categorical_value, null);
  assert.deepEqual(numeric.metadata, { rubric: 'manual' });
  assert.equal(categorical.value, 'pass');
  assert.equal(boolean.value, true);
  assert.equal(text.value, 'Check linked issue before release.');

  const rows = getDb().prepare(`
    SELECT value_type, numeric_value, categorical_value, boolean_value, text_value
    FROM trace_quality_scores
    ORDER BY id
  `).all() as Array<{
    value_type: string;
    numeric_value: number | null;
    categorical_value: string | null;
    boolean_value: number | null;
    text_value: string | null;
  }>;
  assert.deepEqual(rows, [
    { value_type: 'numeric', numeric_value: 0.91, categorical_value: null, boolean_value: null, text_value: null },
    { value_type: 'categorical', numeric_value: null, categorical_value: 'pass', boolean_value: null, text_value: null },
    { value_type: 'boolean', numeric_value: null, categorical_value: null, boolean_value: 1, text_value: null },
    { value_type: 'text', numeric_value: null, categorical_value: null, boolean_value: null, text_value: 'Check linked issue before release.' },
  ]);
});

test('scores can be patched and deleted without leaving stale value columns', () => {
  const score = createTraceQualityScore({
    target_type: 'trace',
    target_id: 'trace-1',
    name: 'quality',
    value_type: 'categorical',
    value: 'pass',
    source: 'human',
  });

  const updated = updateTraceQualityScore(score.id, {
    value_type: 'numeric',
    value: 0.4,
    comment: 'Needs more work',
    metadata: { changed: true },
  });
  assert.equal(updated.value_type, 'numeric');
  assert.equal(updated.numeric_value, 0.4);
  assert.equal(updated.categorical_value, null);
  assert.equal(updated.value, 0.4);
  assert.deepEqual(updated.metadata, { changed: true });

  assert.equal(deleteTraceQualityScore(score.id), true);
  assert.equal(deleteTraceQualityScore(score.id), false);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM trace_quality_scores').get() as { c: number }).c, 0);
});

test('deterministic code evaluator scores can be regenerated without duplicates', () => {
  const first = runTraceQualityCodeEvaluators({ highCostUsdThreshold: 0.5 });
  const second = runTraceQualityCodeEvaluators({ highCostUsdThreshold: 0.5 });

  assert.equal(first.created, 6);
  assert.equal(first.deleted, 0);
  assert.equal(second.created, 6);
  assert.equal(second.deleted, 6);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM trace_quality_scores').get() as { c: number }).c, 6);

  const rows = getDb().prepare(`
    SELECT target_type, target_id, name, boolean_value, source, evaluator_name
    FROM trace_quality_scores
    ORDER BY name, target_id
  `).all() as Array<{
    target_type: string;
    target_id: string;
    name: string;
    boolean_value: number;
    source: string;
    evaluator_name: string;
  }>;

  assert.deepEqual(rows, [
    ['session', 'session-1', 'high_cost_session', 1, 'code_evaluator', 'high_cost_session'],
    ['trace', 'trace-low', 'low_fidelity_trace', 1, 'code_evaluator', 'low_fidelity_trace'],
    ['observation', 'obs-generation-unpriced', 'missing_pricing', 1, 'code_evaluator', 'missing_pricing'],
    ['observation', 'obs-tool-error', 'rate_limit_or_error', 1, 'code_evaluator', 'rate_limit_or_error'],
    ['observation', 'obs-tool-error', 'tool_success', 0, 'code_evaluator', 'tool_success'],
    ['observation', 'obs-tool-ok', 'tool_success', 1, 'code_evaluator', 'tool_success'],
  ].map(([target_type, target_id, name, boolean_value, source, evaluator_name]) => ({
    target_type,
    target_id,
    name,
    boolean_value,
    source,
    evaluator_name,
  })));
});
