/**
 * Storage + analytics-read baseline harness for the schema-storage-rebalance work.
 *
 * Emits a JSON snapshot of:
 *   - whole-DB storage metrics (page/freelist/total bytes)
 *   - top tables/indexes by on-disk bytes (dbstat)
 *   - row counts for the tables this effort targets
 *   - median timings + query plans for the hot, event-scanning read patterns
 *
 * These are the exact patterns each phase claims to improve, so re-running this
 * before/after a phase proves (or disproves) the delta. Read-only: it never
 * mutates the database.
 *
 *   pnpm bench:storage                 # print JSON to stdout
 *   pnpm bench:storage --write-baseline  # also (re)write the baseline doc
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';

const SIZE_TABLES = [
  'events',
  'messages',
  'session_items',
  'session_turns',
  'browsing_sessions',
  'trace_quality_traces',
  'trace_quality_observations',
  'trace_quality_projection_state',
  'trace_quality_scores',
] as const;

interface BenchQuery {
  name: string;
  /** Which later phase is expected to move this number. */
  targetedBy: string;
  sql: string;
  params: (since: string) => unknown[];
}

const BENCH_QUERIES: BenchQuery[] = [
  {
    name: 'events_daily_model_cost',
    targetedBy: 'phase-1-index, phase-2-rollup',
    sql: `SELECT date(created_at) AS d, model,
            SUM(tokens_in) AS ti, SUM(tokens_out) AS to_, SUM(cost_usd) AS cost
          FROM events
          WHERE created_at >= ?
          GROUP BY d, model`,
    params: since => [since],
  },
  {
    name: 'events_monitor_totals',
    targetedBy: 'phase-2-rollup',
    sql: `SELECT COUNT(*) AS c, COALESCE(SUM(tokens_in),0) AS ti,
            COALESCE(SUM(tokens_out),0) AS to_, COALESCE(SUM(cost_usd),0) AS cost
          FROM events
          WHERE created_at >= ?`,
    params: since => [since],
  },
  {
    name: 'events_tool_breakdown',
    targetedBy: 'phase-1-index, phase-2-rollup',
    sql: `SELECT tool_name, COUNT(*) AS c
          FROM events
          WHERE created_at >= ? AND tool_name IS NOT NULL
          GROUP BY tool_name
          ORDER BY c DESC`,
    params: since => [since],
  },
  {
    name: 'monitor_session_list_n1',
    targetedBy: 'phase-1-index (idx_events_session_cost), phase-2-join-rewrite',
    sql: `SELECT s.id,
            COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) AS event_count,
            COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) AS tokens_in,
            COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) AS tokens_out,
            COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) AS total_cost_usd
          FROM sessions s
          ORDER BY datetime(s.last_event_at) DESC, s.id DESC
          LIMIT 50`,
    params: () => [],
  },
];

interface QueryResult {
  name: string;
  targetedBy: string;
  median_ms: number;
  runs_ms: number[];
  rows: number;
  plan: string;
}

interface Snapshot {
  captured_at: string;
  db_path: string;
  storage: {
    page_size: number;
    page_count: number;
    total_bytes: number;
    freelist_pages: number;
    freelist_bytes: number;
  };
  top_objects_by_bytes: Array<{ name: string; bytes: number }>;
  row_counts: Record<string, number>;
  window_since: string;
  queries: QueryResult[];
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function timeQuery(db: Database.Database, q: BenchQuery, since: string): { median_ms: number; runs_ms: number[]; rows: number; plan: string } {
  const stmt = db.prepare(q.sql);
  const params = q.params(since);
  const runs: number[] = [];
  let rows = 0;
  // 6 runs, drop the first (cold) and report the median of the warm 5.
  for (let i = 0; i < 6; i++) {
    const start = process.hrtime.bigint();
    const result = stmt.all(...params) as unknown[];
    const end = process.hrtime.bigint();
    runs.push(Number(end - start) / 1e6);
    rows = result.length;
  }
  const warm = runs.slice(1);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...params) as Array<{ detail: string }>)
    .map(r => r.detail)
    .join(' | ');
  return { median_ms: Number(median(warm).toFixed(2)), runs_ms: warm.map(n => Number(n.toFixed(2))), rows, plan };
}

function main(): void {
  const writeBaseline = process.argv.includes('--write-baseline');
  const db = new Database(config.dbPath, { readonly: true });

  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const freelist = Number(db.pragma('freelist_count', { simple: true }));

  const sizes = db
    .prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 15`)
    .all() as Array<{ name: string; bytes: number }>;

  const rowCounts: Record<string, number> = {};
  for (const t of SIZE_TABLES) {
    try {
      rowCounts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    } catch {
      rowCounts[t] = -1; // table absent
    }
  }

  // Deterministic 60-day window anchored to the newest event, not wall-clock now.
  const maxCreated = (db.prepare(`SELECT MAX(created_at) AS m FROM events`).get() as { m: string | null }).m;
  const since = maxCreated
    ? (db.prepare(`SELECT datetime(?, '-60 days') AS s`).get(maxCreated) as { s: string }).s
    : '1970-01-01';

  const queries: QueryResult[] = BENCH_QUERIES.map(q => ({ name: q.name, targetedBy: q.targetedBy, ...timeQuery(db, q, since) }));

  const snapshot: Snapshot = {
    captured_at: new Date().toISOString(),
    db_path: config.dbPath,
    storage: {
      page_size: pageSize,
      page_count: pageCount,
      total_bytes: pageSize * pageCount,
      freelist_pages: freelist,
      freelist_bytes: pageSize * freelist,
    },
    top_objects_by_bytes: sizes,
    row_counts: rowCounts,
    window_since: since,
    queries,
  };

  db.close();
  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');

  if (writeBaseline) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const outPath = path.resolve(here, '../docs/specs/baselines/2026-06-29-storage-baseline.md');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderBaseline(snapshot));
    process.stderr.write(`baseline written: ${outPath}\n`);
  }
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function renderBaseline(s: Snapshot): string {
  const objectRows = s.top_objects_by_bytes
    .map((o: { name: string; bytes: number }) => `| \`${o.name}\` | ${fmtBytes(o.bytes)} |`)
    .join('\n');
  const rowCountRows = Object.entries(s.row_counts)
    .map(([k, v]) => `| \`${k}\` | ${v === -1 ? '(absent)' : (v as number).toLocaleString()} |`)
    .join('\n');
  const queryRows = s.queries
    .map(
      (q: { name: string; median_ms: number; rows: number; targetedBy: string; plan: string }) =>
        `| \`${q.name}\` | ${q.median_ms} ms | ${q.rows} | ${q.targetedBy} | ${q.plan.includes('TEMP B-TREE') ? 'yes' : 'no'} |`,
    )
    .join('\n');

  return `---
date: 2026-06-29
topic: schema-storage-rebalance
stage: baseline
status: reference
source: tooling
---

# Storage Baseline — schema-storage-rebalance

Generated by \`pnpm bench:storage --write-baseline\`. Re-run after each phase and
compare. **Do not hand-edit the numbers** — regenerate.

- Captured: ${s.captured_at}
- DB: \`${s.db_path}\`
- Total size: **${fmtBytes(s.storage.total_bytes)}** (${s.storage.page_count.toLocaleString()} pages × ${s.storage.page_size} B)
- Free pages: ${s.storage.freelist_pages.toLocaleString()} (${fmtBytes(s.storage.freelist_bytes)})
- Benchmark window: events created since \`${s.window_since}\`

## Top objects by on-disk bytes

| object | bytes |
| --- | --- |
${objectRows}

## Targeted table row counts

| table | rows |
| --- | --- |
${rowCountRows}

## Hot read timings (median of 5 warm runs)

| query | median | rows | targeted by | temp b-tree |
| --- | --- | --- | --- | --- |
${queryRows}
`;
}

main();
