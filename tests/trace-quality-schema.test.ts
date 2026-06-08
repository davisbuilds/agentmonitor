import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  TRACE_QUALITY_EXPORT_PROVIDERS,
  TRACE_QUALITY_OBSERVATION_TYPES,
  TRACE_QUALITY_PAYLOAD_POLICIES,
  TRACE_QUALITY_SCORE_VALUE_TYPES,
  TRACE_QUALITY_SOURCE_KINDS,
} from '../src/trace-quality/constants.js';
import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;

function tableColumns(tableName: string): Set<string> {
  const db = getDb();
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(col => col.name),
  );
}

function indexNames(tableName: string): Set<string> {
  const db = getDb();
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(tableName) as Array<{ name: string }>)
      .map(row => row.name),
  );
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-trace-quality-schema-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('initSchema creates trace quality tables with privacy and export columns', () => {
  const expectedColumns: Record<string, string[]> = {
    trace_quality_traces: [
      'id',
      'session_id',
      'browsing_session_id',
      'source_trace_id',
      'agent_type',
      'name',
      'status',
      'project',
      'branch',
      'started_at',
      'ended_at',
      'duration_ms',
      'metadata_json',
      'tags_json',
      'coverage_json',
      'created_at',
    ],
    trace_quality_observations: [
      'id',
      'trace_id',
      'parent_observation_id',
      'session_id',
      'source_kind',
      'source_id',
      'source_item_id',
      'observation_type',
      'name',
      'status',
      'status_message',
      'severity',
      'model',
      'tool_name',
      'started_at',
      'ended_at',
      'duration_ms',
      'tokens_in',
      'tokens_out',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost_usd',
      'input_hash',
      'output_hash',
      'input_summary',
      'output_summary',
      'payload_policy',
      'metadata_json',
      'created_at',
    ],
    trace_quality_scores: [
      'id',
      'target_type',
      'target_id',
      'name',
      'value_type',
      'numeric_value',
      'categorical_value',
      'boolean_value',
      'text_value',
      'source',
      'evaluator_name',
      'comment',
      'metadata_json',
      'created_at',
    ],
    trace_quality_prompt_refs: [
      'id',
      'name',
      'version',
      'label',
      'source',
      'content_hash',
      'file_path',
      'metadata_json',
      'created_at',
    ],
    trace_quality_observation_prompts: [
      'observation_id',
      'prompt_ref_id',
      'created_at',
    ],
    trace_quality_projection_state: [
      'source_table',
      'source_id',
      'projection_version',
      'trace_id',
      'observation_id',
      'payload_hash',
      'status',
      'projected_at',
      'error_message',
      'metadata_json',
      'created_at',
    ],
    trace_quality_export_state: [
      'id',
      'provider',
      'local_trace_id',
      'local_observation_id',
      'external_trace_id',
      'external_observation_id',
      'payload_hash',
      'status',
      'exported_at',
      'error_message',
      'metadata_json',
      'created_at',
    ],
  };

  for (const [tableName, columns] of Object.entries(expectedColumns)) {
    const actualColumns = tableColumns(tableName);
    for (const column of columns) {
      assert.ok(actualColumns.has(column), `missing ${tableName}.${column}`);
    }
  }
});

test('trace quality tables can represent nested observations, scores, prompt refs, and export state', () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO trace_quality_traces (
      id, session_id, browsing_session_id, agent_type, name, status, project, branch,
      started_at, ended_at, duration_ms, metadata_json, tags_json, coverage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trace-1',
    'session-1',
    'browse-1',
    'codex',
    'User turn',
    'success',
    'agentmonitor',
    'main',
    '2026-06-07T10:00:00Z',
    '2026-06-07T10:00:03Z',
    3000,
    '{"source":"test"}',
    '["test"]',
    '{"has_full_transcript":false}',
  );

  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, session_id, source_kind, source_id, source_item_id, observation_type,
      name, status, status_message, severity, model, started_at, ended_at, duration_ms,
      tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd,
      input_hash, output_hash, input_summary, output_summary, payload_policy, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-root',
    'trace-1',
    'session-1',
    'event',
    'evt-1',
    null,
    'generation',
    'Assistant response',
    'success',
    null,
    'info',
    'gpt-5',
    '2026-06-07T10:00:01Z',
    '2026-06-07T10:00:02Z',
    1000,
    10,
    20,
    1,
    2,
    0.01,
    'hash-input',
    'hash-output',
    'User prompt summary',
    'Assistant output summary',
    'summary_only',
    '{"projection":"unit-test"}',
  );

  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, parent_observation_id, session_id, source_kind, source_id,
      observation_type, name, status, tool_name, payload_policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-child',
    'trace-1',
    'obs-root',
    'session-1',
    'session_item',
    '12',
    'tool',
    'Read',
    'success',
    'Read',
    'source_ref',
  );

  const promptRefId = db.prepare(`
    INSERT INTO trace_quality_prompt_refs (
      name, version, label, source, content_hash, file_path, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('system-instructions', '2026-06-07', 'default', 'file', 'prompt-hash', '/tmp/prompt.md', '{}').lastInsertRowid;

  db.prepare(`
    INSERT INTO trace_quality_observation_prompts (observation_id, prompt_ref_id)
    VALUES (?, ?)
  `).run('obs-root', promptRefId);

  db.prepare(`
    INSERT INTO trace_quality_scores (
      target_type, target_id, name, value_type, numeric_value, source, evaluator_name, comment, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('observation', 'obs-root', 'quality', 'numeric', 0.75, 'human', 'reviewer', 'Looks OK', '{}');

  db.prepare(`
    INSERT INTO trace_quality_projection_state (
      source_table, source_id, projection_version, trace_id, observation_id, payload_hash, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('events', '1', 'v1', 'trace-1', 'obs-root', 'payload-hash', 'projected', '{}');

  db.prepare(`
    INSERT INTO trace_quality_export_state (
      provider, local_trace_id, local_observation_id, external_trace_id, external_observation_id,
      payload_hash, status, exported_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('langfuse', 'trace-1', 'obs-root', 'lf-trace-1', 'lf-obs-1', 'export-hash', 'exported', '2026-06-07T10:00:04Z', '{}');

  const child = db.prepare(`
    SELECT child.parent_observation_id, parent.name AS parent_name
    FROM trace_quality_observations child
    JOIN trace_quality_observations parent ON parent.id = child.parent_observation_id
    WHERE child.id = ?
  `).get('obs-child') as { parent_observation_id: string; parent_name: string };
  assert.deepEqual(child, { parent_observation_id: 'obs-root', parent_name: 'Assistant response' });

  const scoreCount = (db.prepare('SELECT COUNT(*) AS c FROM trace_quality_scores WHERE target_id = ?')
    .get('obs-root') as { c: number }).c;
  const promptCount = (db.prepare('SELECT COUNT(*) AS c FROM trace_quality_observation_prompts WHERE observation_id = ?')
    .get('obs-root') as { c: number }).c;
  const exportCount = (db.prepare('SELECT COUNT(*) AS c FROM trace_quality_export_state WHERE local_trace_id = ?')
    .get('trace-1') as { c: number }).c;

  assert.equal(scoreCount, 1);
  assert.equal(promptCount, 1);
  assert.equal(exportCount, 1);

  initSchema();
  const retainedTraceCount = (db.prepare('SELECT COUNT(*) AS c FROM trace_quality_traces WHERE id = ?')
    .get('trace-1') as { c: number }).c;
  assert.equal(retainedTraceCount, 1);
});

test('trace quality schema indexes common lookup paths', () => {
  const expectedIndexes: Record<string, string[]> = {
    trace_quality_traces: [
      'idx_tq_traces_session',
      'idx_tq_traces_browsing_session',
      'idx_tq_traces_started_at',
      'idx_tq_traces_agent_type',
    ],
    trace_quality_observations: [
      'idx_tq_observations_trace',
      'idx_tq_observations_parent',
      'idx_tq_observations_session',
      'idx_tq_observations_source',
      'idx_tq_observations_type',
      'idx_tq_observations_model',
      'idx_tq_observations_tool_name',
    ],
    trace_quality_scores: [
      'idx_tq_scores_target',
      'idx_tq_scores_name',
    ],
    trace_quality_prompt_refs: [
      'idx_tq_prompt_refs_name_version',
    ],
    trace_quality_export_state: [
      'idx_tq_export_provider_status',
      'idx_tq_export_local_trace',
    ],
  };

  for (const [tableName, expected] of Object.entries(expectedIndexes)) {
    const actualIndexes = indexNames(tableName);
    for (const indexName of expected) {
      assert.ok(actualIndexes.has(indexName), `missing ${indexName}`);
    }
  }
});

test('trace quality constants expose supported enum values', () => {
  assert.ok(TRACE_QUALITY_OBSERVATION_TYPES.includes('generation'));
  assert.ok(TRACE_QUALITY_OBSERVATION_TYPES.includes('tool'));
  assert.ok(TRACE_QUALITY_SOURCE_KINDS.includes('session_item'));
  assert.ok(TRACE_QUALITY_SCORE_VALUE_TYPES.includes('numeric'));
  assert.ok(TRACE_QUALITY_PAYLOAD_POLICIES.includes('summary_only'));
  assert.ok(TRACE_QUALITY_EXPORT_PROVIDERS.includes('langfuse'));
});

test('trace quality tables reject invalid enum-like values before persistence', () => {
  const db = getDb();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO trace_quality_observations (
        id, trace_id, session_id, source_kind, observation_type, name, payload_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('obs-invalid-type', 'trace-1', 'session-1', 'event', 'not-real', 'Invalid', 'summary_only');
  });

  assert.throws(() => {
    db.prepare(`
      INSERT INTO trace_quality_observations (
        id, trace_id, session_id, source_kind, observation_type, name, payload_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('obs-invalid-policy', 'trace-1', 'session-1', 'event', 'tool', 'Invalid', 'raw');
  });

  assert.throws(() => {
    db.prepare(`
      INSERT INTO trace_quality_scores (target_type, target_id, name, value_type, source)
      VALUES (?, ?, ?, ?, ?)
    `).run('trace', 'trace-1', 'invalid-score', 'bogus', 'human');
  });

  assert.throws(() => {
    db.prepare(`
      INSERT INTO trace_quality_export_state (provider, local_trace_id, status)
      VALUES (?, ?, ?)
    `).run('unknown-provider', 'trace-1', 'pending');
  });
});
