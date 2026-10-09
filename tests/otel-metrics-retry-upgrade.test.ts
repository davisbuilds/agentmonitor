import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// An existing database gets the operational-metric retry key on upgrade. Rows
// stored before it carry no key, and the stored row keeps only the projected
// attributes, so an old duplicate cannot be told apart from two genuine points
// of different series: those rows are kept as they are, and the unique index
// must still create over them.

let dir = '';
let closeDb: (() => void) | undefined;

after(() => {
  closeDb?.();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrading a database with duplicate operational rows keeps them and dedups new retries', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-otel-metrics-upgrade-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(dir, 'test.db');
  const connection = await import('../src/db/connection.js');
  closeDb = connection.closeDb;
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

  // The otel_metrics shape before the retry key, holding a retried point twice.
  db.exec(`
    CREATE TABLE otel_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      attrs TEXT,
      value REAL NOT NULL,
      temporality TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      client_timestamp TEXT
    );
    INSERT INTO otel_metrics (session_id, agent_type, metric_name, attrs, value, temporality, client_timestamp)
    VALUES ('s-old', 'codex', 'codex.memory.startup', '{"state":"succeeded"}', 1, 'delta', '2026-09-01T00:00:00.000Z'),
           ('s-old', 'codex', 'codex.memory.startup', '{"state":"succeeded"}', 1, 'delta', '2026-09-01T00:00:00.000Z');
  `);

  const schema = await import('../src/db/schema.js');
  schema.initSchema();

  const index = db.prepare(`SELECT "unique" AS is_unique FROM pragma_index_list('otel_metrics') WHERE name = 'idx_otel_metrics_point_id'`)
    .get() as { is_unique: number } | undefined;
  assert.equal(index?.is_unique, 1, 'the retry key is enforced by a unique index');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM otel_metrics').get() as { c: number }).c, 2, 'pre-existing rows are kept');

  const { insertOperationalMetrics } = await import('../src/db/otel-metrics.js');
  const point = {
    point_id: 'otel-metric-retried', session_id: 's-new', agent_type: 'codex', metric_name: 'codex.memory.startup',
    attrs: { state: 'succeeded' }, value: 1, temporality: 'delta' as const, client_timestamp: '2026-10-01T00:00:00.000Z',
  };
  assert.equal(insertOperationalMetrics([point]), 1);
  assert.equal(insertOperationalMetrics([point]), 0, 'a retried point inserts nothing');
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM otel_metrics WHERE session_id = 's-new'`).get() as { c: number }).c, 1);
});

test('a read-only command adds the retry key to a v16 database', async () => {
  const connection = await import('../src/db/connection.js');
  const schema = await import('../src/db/schema.js');
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  // Read commands skip DDL once user_version is current, so the key only
  // arrives on them if the version moves past the schema without it.
  db.exec('DROP INDEX idx_otel_metrics_point_id; ALTER TABLE otel_metrics DROP COLUMN point_id; PRAGMA user_version = 16');

  schema.ensureSchemaForRead();

  const columns = (db.prepare('PRAGMA table_info(otel_metrics)').all() as Array<{ name: string }>).map(column => column.name);
  assert.ok(columns.includes('point_id'));
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_otel_metrics_point_id'`).all(), [{ name: 'idx_otel_metrics_point_id' }]);
  assert.equal(db.pragma('user_version', { simple: true }), 17);
});
