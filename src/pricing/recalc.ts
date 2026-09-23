import type { Database } from 'better-sqlite3';
import { pricingRegistry } from './index.js';
import { attributeCostSources } from './cost-provenance.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';

export interface CostRecalcOptions {
  apply: boolean;
  /**
   * Only price rows that have no cost yet: the backfill after a model gains a
   * rate card. The server runs it on every startup.
   */
  missingOnly?: boolean;
}

export type CostRecalcReport = {
  dry_run: boolean;
  missing_only: boolean;
  scanned: number;
  updated: number;
  unchanged: number;
  unknown_model: number;
  /** Pre-provenance cost rows labelled before recalculating (or, dry, that would be). */
  costs_attributed: number;
  sessions_resummarized: number;
};

interface CostRow {
  id: number;
  session_id: string;
  source: string | null;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  created_at: string;
  client_timestamp: string | null;
}

const DRY_RUN_ROLLBACK = Symbol('dry-run rollback');

/**
 * Re-derive event costs from the pricing tables, pricing each row at its own
 * time. Only rows with no cost or an estimated one are candidates: a reported
 * cost is the producer's figure and is never rewritten. Cost rows that predate
 * provenance are labelled first, so none is mistaken for an estimate. A dry run
 * does the same labelling inside a transaction it rolls back, so its report
 * matches what applying would do.
 */
export function recalculateEventCosts(db: Database, options: CostRecalcOptions): CostRecalcReport {
  if (options.apply) return recalculate(db, options);
  let report: CostRecalcReport | undefined;
  try {
    db.transaction(() => {
      report = recalculate(db, options);
      throw DRY_RUN_ROLLBACK;
    })();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  return report!;
}

function recalculate(db: Database, options: CostRecalcOptions): CostRecalcReport {
  const missingOnly = options.missingOnly ?? false;
  const costsAttributed = attributeCostSources(db);
  // The missing-only WHERE must match idx_events_cost_pending (src/db/schema.ts)
  // so the startup backfill finds its handful of rows without a table scan.
  const events = db.prepare(`
    SELECT id, session_id, source, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
           cost_usd, created_at, client_timestamp
    FROM events
    WHERE cost_usd IS NULL AND model IS NOT NULL
      AND (tokens_in > 0 OR tokens_out > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0)
    ${missingOnly ? '' : `
    UNION ALL
    SELECT id, session_id, source, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
           cost_usd, created_at, client_timestamp
    FROM events
    WHERE cost_source = 'estimated' AND model IS NOT NULL
      AND (tokens_in > 0 OR tokens_out > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0)`}
  `).all() as CostRow[];

  const update = db.prepare("UPDATE events SET cost_usd = ?, cost_source = 'estimated' WHERE id = ?");
  const touchedSessions = new Set<string>();
  let updated = 0;
  let unchanged = 0;
  let unknownModel = 0;

  db.transaction(() => {
    for (const event of events) {
      const cost = pricingRegistry.calculate(event.model, {
        input: event.tokens_in,
        output: event.tokens_out,
        cacheRead: event.cache_read_tokens,
        cacheWrite: event.cache_write_tokens,
      }, event.client_timestamp ?? event.created_at);
      if (cost === null) {
        unknownModel++;
        continue;
      }
      const rounded = Math.round(cost * 1e10) / 1e10;
      const existing = event.cost_usd !== null ? Math.round(event.cost_usd * 1e10) / 1e10 : null;
      if (existing === rounded) {
        unchanged++;
        continue;
      }
      if (options.apply) {
        update.run(rounded, event.id);
        // Benchmark sessions never get a trace summary; the benchmarks API is
        // the only surface that includes them.
        if (event.source !== 'benchmark') touchedSessions.add(event.session_id);
      }
      updated++;
    }

    // session_trace_summary caches each session's cost, so re-derive it for
    // every session whose events changed. Inside the transaction: if a summary
    // fails, the costs roll back too, and a retry still finds the rows to redo.
    for (const sessionId of touchedSessions) maintainSessionTraceSummary(sessionId);
  })();

  return {
    dry_run: !options.apply,
    missing_only: missingOnly,
    scanned: events.length,
    updated,
    unchanged,
    unknown_model: unknownModel,
    costs_attributed: costsAttributed,
    sessions_resummarized: touchedSessions.size,
  };
}
