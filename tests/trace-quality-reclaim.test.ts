import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { getDb as getDbType, closeDb as closeDbType } from '../src/db/connection.js';
import type { ensureTraceQualityExportStateFkFree as ensureFkFreeType } from '../src/db/schema.js';

let tempDir = '';
let getDb: typeof getDbType;
let closeDb: typeof closeDbType;
let ensureTraceQualityExportStateFkFree: typeof ensureFkFreeType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-tq-reclaim-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'legacy.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  ensureTraceQualityExportStateFkFree = (await import('../src/db/schema.js')).ensureTraceQualityExportStateFkFree;
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Recreate the pre-reframe shape: export_state with FKs to the warehouse tables. */
function seedLegacyExportState(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE trace_quality_traces (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE trace_quality_observations (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL);
    CREATE TABLE trace_quality_export_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK (provider IN ('langfuse')),
      local_trace_id TEXT NOT NULL,
      local_observation_id TEXT,
      external_trace_id TEXT,
      external_observation_id TEXT,
      payload_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','exported','failed','skipped')),
      exported_at TEXT,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(local_trace_id) REFERENCES trace_quality_traces(id) ON DELETE CASCADE,
      FOREIGN KEY(local_observation_id) REFERENCES trace_quality_observations(id) ON DELETE CASCADE
    );
    INSERT INTO trace_quality_traces (id, session_id) VALUES ('t1', 's1');
    INSERT INTO trace_quality_export_state (provider, local_trace_id, status) VALUES ('langfuse', 't1', 'pending');
  `);
}

test('export seam survives dropping its former parents after the FK-free migration', () => {
  const db = getDb();
  seedLegacyExportState();

  // Sanity: the legacy table really does carry the FK.
  const before = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trace_quality_export_state'").get() as { sql: string }).sql;
  assert.match(before, /REFERENCES\s+trace_quality_traces/i);

  ensureTraceQualityExportStateFkFree(db);

  const after = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trace_quality_export_state'").get() as { sql: string }).sql;
  assert.doesNotMatch(after, /REFERENCES\s+trace_quality_/i, 'FKs to the warehouse tables are gone');

  // The pre-existing row is preserved through the rebuild.
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM trace_quality_export_state').get() as { c: number }).c, 1);
  // Indexes were recreated.
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_tq_export_local_trace'").get());

  // The whole point: dropping the former parents no longer breaks inserts.
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TABLE trace_quality_traces; DROP TABLE trace_quality_observations;');
  db.pragma('foreign_keys = ON');
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO trace_quality_export_state (provider, local_trace_id, status) VALUES ('langfuse', 'orphan', 'pending')").run();
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM trace_quality_export_state').get() as { c: number }).c, 2);
});

test('the migration is a no-op when export_state is already FK-free or absent', () => {
  const db = getDb();
  // Already FK-free now (previous test rebuilt it); re-running must not change it.
  const sqlBefore = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trace_quality_export_state'").get() as { sql: string }).sql;
  ensureTraceQualityExportStateFkFree(db);
  const sqlAfter = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trace_quality_export_state'").get() as { sql: string }).sql;
  assert.equal(sqlAfter, sqlBefore);

  db.exec('DROP TABLE trace_quality_export_state');
  assert.doesNotThrow(() => ensureTraceQualityExportStateFkFree(db)); // absent → no-op
});
