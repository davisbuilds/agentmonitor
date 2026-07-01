import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import type { WarehouseRunRow } from '../src/warehouse/types.js';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let initSchema: typeof import('../src/db/schema.js').initSchema;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let getDb: typeof import('../src/db/connection.js').getDb;
let listWarehouseSessionTraceSummaries: typeof import('../src/warehouse/source.js').listWarehouseSessionTraceSummaries;
let mapSummaryToRunRow: typeof import('../src/warehouse/runs-export.js').mapSummaryToRunRow;
let assertContentFree: typeof import('../src/warehouse/runs-export.js').assertContentFree;
let applyMinBatch: typeof import('../src/warehouse/runs-export.js').applyMinBatch;
let buildLineage: typeof import('../src/warehouse/runs-export.js').buildLineage;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-warehouse-export-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'warehouse.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ closeDb, getDb } = await import('../src/db/connection.js'));
  ({ listWarehouseSessionTraceSummaries } = await import('../src/warehouse/source.js'));
  ({ mapSummaryToRunRow, assertContentFree, applyMinBatch, buildLineage } = await import('../src/warehouse/runs-export.js'));
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
  initSchema();
  getDb().exec('DELETE FROM session_trace_summary');
  seedSummaries();
});

function insertSummary(row: {
  session_id: string;
  trace_id?: string | null;
  agent_type?: string | null;
  project?: string | null;
  primary_model?: string | null;
  started_at?: string | null;
  updated_at: string;
  tokens_in?: number;
  tokens_out?: number;
}): void {
  getDb().prepare(`
    INSERT INTO session_trace_summary (
      session_id, trace_id, agent_type, project, primary_model, started_at, ended_at,
      observation_count, error_count, tokens_in, tokens_out, cache_read_tokens,
      cache_write_tokens, cost_usd, latency_ms_total, coverage_json, quality_score,
      quality_grade, projection_version, updated_at
    ) VALUES (
      @session_id, @trace_id, @agent_type, @project, @primary_model, @started_at, @ended_at,
      3, 1, @tokens_in, @tokens_out, 7, 8, 0.0123, 456, '{}', 0.82, 'B', 'sts:test', @updated_at
    )
  `).run({
    session_id: row.session_id,
    trace_id: row.trace_id ?? `trace-${row.session_id}`,
    agent_type: Object.hasOwn(row, 'agent_type') ? row.agent_type : 'codex',
    project: Object.hasOwn(row, 'project') ? row.project : 'agentmonitor',
    primary_model: Object.hasOwn(row, 'primary_model') ? row.primary_model : 'gpt-5.4',
    started_at: row.started_at ?? null,
    ended_at: row.started_at ?? null,
    updated_at: row.updated_at,
    tokens_in: row.tokens_in ?? 100,
    tokens_out: row.tokens_out ?? 50,
  });
}

function seedSummaries(): void {
  insertSummary({
    session_id: 's-2026-06-15',
    started_at: '2026-06-15T23:30:00.000Z',
    updated_at: '2026-06-16 00:00:00',
  });
  insertSummary({
    session_id: 's-null-start',
    started_at: null,
    updated_at: '2026-06-16 09:00:00',
    primary_model: null,
    project: null,
    agent_type: null,
  });
  insertSummary({
    session_id: 's-2026-06-17',
    started_at: '2026-06-17T00:00:00.000Z',
    updated_at: '2026-06-17 00:00:00',
  });
}

function sampleRunRow(): WarehouseRunRow {
  const summary = listWarehouseSessionTraceSummaries({ date_from: '2026-06-15', date_to: '2026-06-15' })[0];
  assert.ok(summary);
  return mapSummaryToRunRow(summary, 'local', 'run-1');
}

test('warehouse summary source returns raw rows with date-only end dates inclusive', () => {
  const rows = listWarehouseSessionTraceSummaries({ date_from: '2026-06-15', date_to: '2026-06-16' });

  assert.deepEqual(rows.map(row => row.session_id), ['s-2026-06-15', 's-null-start']);
  assert.equal(rows[0]?.tokens_in, 100);
  assert.equal(rows[0]?.coverage_json, '{}');
  assert.equal(rows[1]?.started_at, null);
});

test('warehouse summary source filters nullable starts by updated_at fallback', () => {
  const rows = listWarehouseSessionTraceSummaries({ date_from: '2026-06-16', date_to: '2026-06-16' });

  assert.deepEqual(rows.map(row => row.session_id), ['s-null-start']);
});

test('summary rows map exactly to content-free warehouse run rows', () => {
  const rows = listWarehouseSessionTraceSummaries({ date_from: '2026-06-16', date_to: '2026-06-16' });
  const row = mapSummaryToRunRow(rows[0]!, 'local', 'run-1');

  assert.deepEqual(row, {
    account: 'local',
    session_id: 's-null-start',
    model: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 7,
    cache_write_tokens: 8,
    cost_usd: 0.0123,
    latency_ms: 456,
    observation_count: 3,
    error_count: 1,
    quality_score: 0.82,
    quality_grade: 'B',
    project: null,
    agent_type: null,
    started_at: '2026-06-16T09:00:00.000Z',
    day: '2026-06-16',
    published_run_id: 'run-1',
  });
  assert.doesNotThrow(() => assertContentFree(row));
});

test('content-free guard rejects extra and missing fields', () => {
  const row = sampleRunRow();

  assert.throws(() => assertContentFree({ ...row, content: 'leak' } as unknown as WarehouseRunRow), /allowlist/);
  const missing = { ...row } as Partial<WarehouseRunRow>;
  delete missing.model;
  assert.throws(() => assertContentFree(missing as WarehouseRunRow), /allowlist|missing/);
});

test('content-free guard checks text, id, timestamp, date, and numeric shapes', () => {
  const row = sampleRunRow();

  assert.throws(() => assertContentFree({ ...row, project: 'agentmonitor\nsecret' }), /bounded string/);
  assert.throws(() => assertContentFree({ ...row, session_id: '' }), /opaque id/);
  assert.throws(() => assertContentFree({ ...row, started_at: 'not-a-date' }), /ISO timestamp/);
  assert.throws(() => assertContentFree({ ...row, day: '2026-99-99' }), /date/);
  assert.throws(() => assertContentFree({ ...row, input_tokens: Number.NaN }), /numeric/);
  assert.doesNotThrow(() => assertContentFree({ ...row, output_tokens: 999 }));
});

test('min-batch suppresses only undersized manual batches', () => {
  const rows = listWarehouseSessionTraceSummaries({ date_from: '2026-06-15', date_to: '2026-06-16' })
    .map(summary => mapSummaryToRunRow(summary, 'local', 'run-1'));

  const suppressed = applyMinBatch(rows, 3);
  assert.equal(suppressed.published.length, 0);
  assert.equal(suppressed.suppressed.length, 2);

  const published = applyMinBatch(rows, 0);
  assert.equal(published.published.length, 2);
  assert.equal(published.suppressed.length, 0);
});

test('lineage records publish counts, account, window, version, and grant metadata', () => {
  const lineage = buildLineage({
    runId: 'run-1',
    createdAt: '2026-06-30T00:00:00.000Z',
    account: 'local',
    windowStart: '2026-06-15',
    windowEnd: '2026-06-16',
    sessionsPublished: 2,
    sessionsSuppressed: 0,
    minBatch: 0,
    grantRole: 'medallion_bi',
    grantSkipped: true,
  });

  assert.equal(lineage.run_id, 'run-1');
  assert.equal(lineage.account, 'local');
  assert.equal(lineage.sessions_published, 2);
  assert.equal(lineage.grant_role, 'medallion_bi');
  assert.equal(lineage.grant_skipped, true);
  assert.match(lineage.amon_version, /^\d+\.\d+\.\d+/);
});
