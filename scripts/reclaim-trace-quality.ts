#!/usr/bin/env tsx
/**
 * One-shot reclaim for the trace-quality reframe (Phase 3).
 *
 * Drops the persisted trace/observation/score/prompt warehouse tables — which
 * the lean view (session_trace_summary + on-demand projection) no longer reads
 * or writes — and VACUUMs to return the freed pages (~900 MB on a mature DB) to
 * the filesystem. The source tables (events, session_items, session_turns,
 * browsing_sessions, messages) and the lean summary are untouched, so nothing
 * recoverable is lost: the warehouse was a pure derived projection.
 *
 * Explicit and opt-in by design — it is NOT run at startup, so a normal upgrade
 * never rewrites your live DB. The dormant `trace_quality_export_state` seam and
 * `session_trace_summary` are kept.
 *
 *   pnpm reclaim:trace-quality            # drop + VACUUM
 *   pnpm reclaim:trace-quality --dry-run  # report what would be dropped, no changes
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { ensureTraceQualityExportStateFkFree } from '../src/db/schema.js';

const DROP_TABLES = [
  'trace_quality_observation_prompts',
  'trace_quality_projection_state',
  'trace_quality_scores',
  'trace_quality_observations',
  'trace_quality_prompt_refs',
  'trace_quality_traces',
] as const;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name),
  );
}

function rowCount(db: Database.Database, name: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const dbPath = config.dbPath;
  const sizeBefore = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

  const db = new Database(dbPath);
  const present = DROP_TABLES.filter(name => tableExists(db, name));

  if (present.length === 0) {
    console.log('[reclaim] No trace-quality warehouse tables present — nothing to drop.');
    db.close();
    return;
  }

  console.log(`[reclaim] DB: ${dbPath} (${fmtBytes(sizeBefore)})`);
  console.log('[reclaim] Tables to drop:');
  for (const name of present) console.log(`  - ${name} (${rowCount(db, name).toLocaleString()} rows)`);

  if (dryRun) {
    console.log('[reclaim] --dry-run: no changes made. Re-run without --dry-run to drop + VACUUM.');
    db.close();
    return;
  }

  // Repair the dormant export seam first: a pre-reframe DB has it FK-referencing
  // trace_quality_traces/_observations, so dropping those parents would leave it
  // un-insertable (`no such table`). This rebuilds it FK-free if needed.
  ensureTraceQualityExportStateFkFree(db);

  // FK enforcement OFF so dropping a referenced parent doesn't trip cascade
  // bookkeeping; the warehouse tables only reference each other now.
  db.pragma('foreign_keys = OFF');
  const drop = db.transaction(() => {
    for (const name of present) db.exec(`DROP TABLE IF EXISTS ${name}`);
  });
  drop();
  console.log(`[reclaim] Dropped ${present.length} tables. Running VACUUM…`);
  db.exec('VACUUM');
  db.pragma('foreign_keys = ON');
  db.close();

  const sizeAfter = fs.statSync(dbPath).size;
  console.log(
    `[reclaim] Done. ${fmtBytes(sizeBefore)} → ${fmtBytes(sizeAfter)} `
    + `(reclaimed ${fmtBytes(Math.max(0, sizeBefore - sizeAfter))}).`,
  );
}

main();
