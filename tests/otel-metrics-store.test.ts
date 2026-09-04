import assert from 'node:assert/strict';
import test, { before, after, describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type * as OtelMetricsModule from '../src/db/otel-metrics.ts';
import type * as V2QueriesModule from '../src/db/v2-queries.ts';
import type * as QueriesModule from '../src/db/queries.ts';

// Operational-metrics store: insert lands in `otel_metrics`, reads aggregate by
// name×attrs, and — the load-bearing guard — a metric row never reaches the
// `events` table or its usage/count aggregates. Temp DB wired before any import
// so config.ts snapshots the temp path (see AGENTS.md testing note).

let closeDb: () => void;
let getDb: () => BetterSqlite3.Database;
let insertOperationalMetrics: typeof OtelMetricsModule.insertOperationalMetrics;
let getOperationalMetricSummary: typeof V2QueriesModule.getOperationalMetricSummary;
let getStats: typeof QueriesModule.getStats;
let tempDir: string;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-otel-metrics-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  initSchema();
  assert.equal(dbModule.getDb().name, path.join(tempDir, 'test.db'));

  ({ insertOperationalMetrics } = await import('../src/db/otel-metrics.js'));
  ({ getOperationalMetricSummary } = await import('../src/db/v2-queries.js'));
  ({ getStats } = await import('../src/db/queries.js'));
});

after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('operational metrics store', () => {
  test('inserts land in otel_metrics with attrs round-tripped', () => {
    const n = insertOperationalMetrics([
      { session_id: 's1', agent_type: 'codex', metric_name: 'codex.memory.startup', attrs: { state: 'skipped_rate_limit' }, value: 1, temporality: 'delta' },
      { session_id: 's1', agent_type: 'codex', metric_name: 'codex.memory.startup', attrs: { state: 'succeeded' }, value: 1, temporality: 'delta' },
      { session_id: 's1', agent_type: 'codex', metric_name: 'codex.memory.startup', attrs: { state: 'skipped_rate_limit' }, value: 1, temporality: 'delta', client_timestamp: '2026-09-04T10:00:00Z' },
    ]);
    assert.equal(n, 3);
    const stored = getDb().prepare('SELECT COUNT(*) c FROM otel_metrics').get() as { c: number };
    assert.equal(stored.c, 3);
  });

  test('summary groups by name×attrs so distinct states split', () => {
    const summary = getOperationalMetricSummary({ namePrefix: 'codex.memory.' });
    const byState = new Map(summary.map(r => [(r.attrs as { state: string }).state, r]));
    assert.equal(byState.get('skipped_rate_limit')!.occurrences, 2);
    assert.equal(byState.get('succeeded')!.occurrences, 1);
    assert.equal(byState.get('skipped_rate_limit')!.total_value, 2);
  });

  test('a prefix filter that matches nothing returns empty, not everything', () => {
    assert.deepEqual(getOperationalMetricSummary({ namePrefix: 'nonexistent.' }), []);
  });

  test('since compares real time, not raw strings, across ISO vs SQLite formats', () => {
    // client_timestamp is ISO-with-Z ("2026-09-04T10:00:00.000Z"); a naive
    // string compare against datetime()'s space format ("2026-09-04 20:00:00")
    // would keep this 10:00 row for a 20:00 bound because 'T' > ' '. datetime()
    // on both sides makes it a real comparison.
    insertOperationalMetrics([
      { session_id: 's-ts', agent_type: 'codex', metric_name: 'test.since.metric', attrs: { state: 'x' }, value: 1, temporality: 'delta', client_timestamp: '2026-09-04T10:00:00.000Z' },
    ]);
    // 10:00 row, bound 20:00 same day → excluded (it is earlier in real time).
    assert.equal(getOperationalMetricSummary({ namePrefix: 'test.since.', since: '2026-09-04T20:00:00Z' }).length, 0);
    // bound 09:00 same day → included.
    assert.equal(getOperationalMetricSummary({ namePrefix: 'test.since.', since: '2026-09-04T09:00:00Z' }).length, 1);
  });

  test('operational metrics never touch the events table or its stats', () => {
    // The whole reason for a dedicated table: no COUNT(*)/usage aggregate over
    // `events` can see these rows. Assert the events table is untouched.
    const events = getDb().prepare('SELECT COUNT(*) c FROM events').get() as { c: number };
    assert.equal(events.c, 0);
    const stats = getStats({});
    assert.equal(stats.total_events, 0);
    assert.equal(stats.total_cost_usd, 0);
  });
});
