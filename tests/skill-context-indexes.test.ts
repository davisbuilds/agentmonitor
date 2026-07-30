import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-skill-context-indexes-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'skill-context-indexes.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();
  const db = getDb();
  db.prepare(`
    INSERT INTO session_context_observations (
      session_id, ordinal, kind, source, observed_at, skill_name
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('session-1', 1, 'catalog_presentation', 'codex_jsonl', '2026-07-01T00:00:00Z', null);
  const observation = db.prepare(`
    SELECT id FROM session_context_observations WHERE session_id = ?
  `).get('session-1') as { id: number };
  db.prepare(`
    INSERT INTO session_catalog_observation_entries (
      observation_id, ordinal, skill_name
    ) VALUES (?, ?, ?)
  `).run(observation.id, 0, 'test-strategy');
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function indexNames(table: string): Set<string> {
  return new Set(
    (getDb().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
    `).all(table) as Array<{ name: string }>).map(row => row.name),
  );
}

function queryPlan(sql: string, ...params: unknown[]): string {
  return (getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map(row => row.detail)
    .join(' | ');
}

test('skill-context observation and catalog-entry indexes exist', () => {
  const observationIndexes = indexNames('session_context_observations');
  assert.ok(
    observationIndexes.has('idx_sco_session_kind_name_ordinal'),
    'idx_sco_session_kind_name_ordinal should exist',
  );
  assert.ok(
    observationIndexes.has('idx_sco_skill_time'),
    'idx_sco_skill_time should exist',
  );

  const entryIndexes = indexNames('session_catalog_observation_entries');
  assert.ok(
    entryIndexes.has('idx_scoe_observation_ordinal'),
    'idx_scoe_observation_ordinal should exist',
  );
  assert.ok(entryIndexes.has('idx_scoe_skill'), 'idx_scoe_skill should exist');
});

test('session observation reads use the session-kind-name index', () => {
  const plan = queryPlan(
    `SELECT id, ordinal
     FROM session_context_observations
     WHERE session_id = ? AND kind = ? AND skill_name IS NULL
     ORDER BY ordinal`,
    'session-1',
    'catalog_presentation',
  );
  assert.match(
    plan,
    /idx_sco_session_kind_name_ordinal/,
    `expected session observation index, got: ${plan}`,
  );
});

test('catalog-entry reads use the observation-ordinal index', () => {
  const plan = queryPlan(
    `SELECT skill_name
     FROM session_catalog_observation_entries
     WHERE observation_id = ?
     ORDER BY ordinal`,
    1,
  );
  assert.match(
    plan,
    /idx_scoe_observation_ordinal/,
    `expected catalog-entry index, got: ${plan}`,
  );
});
