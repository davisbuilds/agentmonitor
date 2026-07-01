import assert from 'node:assert/strict';
import test from 'node:test';

import { planRuns } from '../src/warehouse/postgres-sink.js';
import type { PublishLineage, WarehouseConfig, WarehouseRunRow } from '../src/warehouse/types.js';

function runRow(overrides: Partial<WarehouseRunRow> = {}): WarehouseRunRow {
  return {
    account: 'local',
    session_id: 'session-1',
    model: 'gpt-5.4',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 10,
    cache_write_tokens: 0,
    cost_usd: 0.012,
    latency_ms: 1234,
    observation_count: 4,
    error_count: 0,
    quality_score: 0.9,
    quality_grade: 'A',
    project: 'agentmonitor',
    agent_type: 'codex',
    started_at: '2026-06-30T10:00:00.000Z',
    day: '2026-06-30',
    published_run_id: 'run-1',
    ...overrides,
  };
}

function lineage(overrides: Partial<PublishLineage> = {}): PublishLineage {
  return {
    run_id: 'run-1',
    created_at: '2026-06-30T10:01:00.000Z',
    account: 'local',
    window_start: '2026-06-30',
    window_end: '2026-06-30',
    sessions_published: 1,
    sessions_suppressed: 0,
    min_batch: 0,
    amon_version: '0.5.0',
    grant_role: 'medallion_bi',
    grant_skipped: false,
    ...overrides,
  };
}

function warehouseConfig(overrides: Partial<WarehouseConfig> = {}): WarehouseConfig {
  return {
    enabled: false,
    dsn: null,
    account: 'local',
    schema: 'agentmonitor',
    biRole: 'medallion_bi',
    ...overrides,
  };
}

test('dry-run plan emits idempotent run upsert, lineage insert, and BI grant lookup', () => {
  const plan = planRuns([runRow()], lineage(), warehouseConfig(), { biRoleExists: true });

  assert.equal(plan.dry_run, true);
  assert.equal(plan.rows_published, 1);
  assert.equal(plan.grant_skipped, false);
  assert.ok(plan.statements.includes('CREATE SCHEMA IF NOT EXISTS agentmonitor'));
  assert.ok(plan.statements.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS agentmonitor.runs')));
  assert.ok(plan.statements.some(statement => (
    statement.includes('INSERT INTO agentmonitor.runs') &&
    statement.includes('ON CONFLICT (account, session_id) DO UPDATE')
  )));
  assert.ok(plan.statements.some(statement => statement.includes('INSERT INTO agentmonitor.publish_run')));
  assert.ok(plan.statements.includes('SELECT 1 FROM pg_roles WHERE rolname = $1'));
  assert.ok(plan.statements.includes('GRANT USAGE ON SCHEMA agentmonitor TO medallion_bi'));
  assert.ok(plan.statements.includes('GRANT SELECT ON ALL TABLES IN SCHEMA agentmonitor TO medallion_bi'));
});

test('dry-run plan records skipped grant when the BI role is absent', () => {
  const plan = planRuns([runRow()], lineage(), warehouseConfig(), { biRoleExists: false });

  assert.equal(plan.grant_skipped, true);
  assert.equal(plan.lineage.grant_skipped, true);
  assert.ok(plan.statements.includes('SELECT 1 FROM pg_roles WHERE rolname = $1'));
  assert.equal(plan.statements.some(statement => statement.startsWith('GRANT ')), false);
});

test('dry-run plan omits role lookup and grant when BI role is disabled', () => {
  const plan = planRuns([runRow()], lineage({ grant_role: null }), warehouseConfig({ biRole: null }));

  assert.equal(plan.grant_role, null);
  assert.equal(plan.grant_skipped, false);
  assert.equal(plan.statements.some(statement => statement.includes('pg_roles')), false);
  assert.equal(plan.statements.some(statement => statement.startsWith('GRANT ')), false);
});

test('sink rejects unsafe schema and role identifiers before planning SQL', () => {
  assert.throws(
    () => planRuns([runRow()], lineage(), warehouseConfig({ schema: 'bad;drop' })),
    /invalid schema identifier/,
  );
  assert.throws(
    () => planRuns([runRow()], lineage(), warehouseConfig({ biRole: 'bad;drop' })),
    /invalid role identifier/,
  );
});
