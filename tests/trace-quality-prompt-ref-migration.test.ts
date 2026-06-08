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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-tq-prompt-ref-migration-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'legacy.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('initSchema upgrades the legacy prompt-ref source CHECK without dropping refs or links', () => {
  const db = getDb();

  // Simulate a pre-upgrade database: trace_quality_prompt_refs with the old source
  // CHECK constraint, plus a join row that references it. The join table carries the
  // real ON DELETE CASCADE foreign key to prompt_refs — the exact relationship the
  // migration must shield with `foreign_keys = OFF`, since a naive DROP of the parent
  // would otherwise cascade-delete every observation_prompts row.
  db.exec(`
    CREATE TABLE trace_quality_prompt_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT,
      label TEXT,
      source TEXT NOT NULL CHECK (source IN ('file', 'inline', 'skill', 'agent_instruction', 'template', 'metadata')),
      content_hash TEXT,
      file_path TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE trace_quality_observation_prompts (
      observation_id TEXT NOT NULL,
      prompt_ref_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (observation_id, prompt_ref_id),
      FOREIGN KEY(prompt_ref_id) REFERENCES trace_quality_prompt_refs(id) ON DELETE CASCADE
    );

    INSERT INTO trace_quality_prompt_refs (id, name, version, label, source, content_hash, file_path, metadata_json, created_at)
    VALUES (7, 'skill:writing-plans', NULL, NULL, 'skill', 'legacy-hash', NULL, '{"legacy":true}', '2026-06-01T00:00:00Z');

    INSERT INTO trace_quality_observation_prompts (observation_id, prompt_ref_id)
    VALUES ('obs-legacy', 7);
  `);

  initSchema();

  // The CHECK constraint now admits the canonical vocabulary while keeping legacy values readable.
  const promptRefSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trace_quality_prompt_refs'",
  ).get() as { sql: string }).sql;
  for (const source of ['skill_file', 'task_template', 'system_prompt', 'manual']) {
    assert.ok(promptRefSql.includes(`'${source}'`), `migrated CHECK missing canonical source ${source}`);
  }
  assert.ok(promptRefSql.includes("'skill'"), 'migrated CHECK should still admit legacy source values');

  // The legacy row is preserved verbatim, including its original id and legacy source.
  const ref = db.prepare(
    'SELECT id, name, source, content_hash, metadata_json FROM trace_quality_prompt_refs WHERE id = 7',
  ).get() as { id: number; name: string; source: string; content_hash: string; metadata_json: string };
  assert.deepEqual(ref, {
    id: 7,
    name: 'skill:writing-plans',
    source: 'skill',
    content_hash: 'legacy-hash',
    metadata_json: '{"legacy":true}',
  });

  // The join row survives the table rebuild (would be cascade-deleted without foreign_keys = OFF)
  // and still resolves to the preserved ref.
  const link = db.prepare(`
    SELECT op.observation_id, pr.name, pr.source
    FROM trace_quality_observation_prompts op
    JOIN trace_quality_prompt_refs pr ON pr.id = op.prompt_ref_id
  `).all();
  assert.deepEqual(link, [{ observation_id: 'obs-legacy', name: 'skill:writing-plans', source: 'skill' }]);

  // Indexes are recreated on the rebuilt table.
  const indexes = new Set(
    (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trace_quality_prompt_refs'",
    ).all() as Array<{ name: string }>).map(row => row.name),
  );
  assert.ok(indexes.has('idx_tq_prompt_refs_name_version'));
  assert.ok(indexes.has('idx_tq_prompt_refs_source'));

  // Foreign key enforcement is restored to its original (ON) state and the schema is consistent.
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  // A canonical source value now inserts cleanly under the migrated constraint.
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO trace_quality_prompt_refs (name, source) VALUES (?, ?)
    `).run('agentmonitor-system', 'system_prompt');
  });

  // Re-running initSchema is a no-op: the migration does not fire again or duplicate rows.
  initSchema();
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM trace_quality_prompt_refs WHERE id = 7').get() as { c: number }).c,
    1,
  );
});
