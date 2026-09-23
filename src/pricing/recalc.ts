import type { Database } from 'better-sqlite3';
import { pricingRegistry } from './index.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';

export interface CostRecalcOptions {
  apply: boolean;
  /**
   * Only price rows that have no cost yet. This is the safe backfill after a
   * model gains a rate card: rows already carrying a cost, including captured
   * provider costs, are left alone.
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
  sessions_resummarized: number;
};

interface CostRow {
  id: number;
  session_id: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  created_at: string;
  client_timestamp: string | null;
}

/** Re-derive event costs from the pricing tables, pricing each row at its own time. */
export function recalculateEventCosts(db: Database, options: CostRecalcOptions): CostRecalcReport {
  const missingOnly = options.missingOnly ?? false;
  const events = db.prepare(`
    SELECT id, session_id, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
           cost_usd, created_at, client_timestamp
    FROM events
    WHERE model IS NOT NULL
      AND (tokens_in > 0 OR tokens_out > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0)
      ${missingOnly ? 'AND cost_usd IS NULL' : ''}
  `).all() as CostRow[];

  const update = db.prepare('UPDATE events SET cost_usd = ? WHERE id = ?');
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
        touchedSessions.add(event.session_id);
      }
      updated++;
    }
  })();

  // session_trace_summary caches each session's cost, so re-derive it for every
  // session whose events changed or it keeps serving the old total.
  for (const sessionId of touchedSessions) maintainSessionTraceSummary(sessionId);

  return {
    dry_run: !options.apply,
    missing_only: missingOnly,
    scanned: events.length,
    updated,
    unchanged,
    unknown_model: unknownModel,
    sessions_resummarized: touchedSessions.size,
  };
}
