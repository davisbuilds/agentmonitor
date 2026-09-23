import type { Database } from 'better-sqlite3';
import { pricingRegistry } from './index.js';

/**
 * Where a stored cost came from. `reported` is the producer's own figure (a
 * captured provider bill, Claude Code's cost attribute) and is never rewritten
 * by a recalc. `estimated` came from our pricing tables and can be re-derived
 * when a rate is added or corrected.
 */
export type CostSource = 'reported' | 'estimated';

// Must match idx_events_cost_unattributed's WHERE clause (src/db/schema.ts).
const UNATTRIBUTED = 'cost_usd IS NOT NULL AND cost_source IS NULL';

interface UnattributedRow {
  id: number;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  created_at: string;
  client_timestamp: string | null;
}

function sameCost(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.abs(b));
}

/**
 * Label cost rows written before provenance was recorded. Returns rows labelled.
 *
 * Producers that never send a cost (the Codex and Antigravity importers, Codex
 * OTEL) wrote estimates, even where a later rate correction means the stored
 * value no longer matches the tables. A benchmark cost is the captured bill.
 * Everywhere else a producer may have sent its own figure, and the row does not
 * say whether it did, so a cost equal to what the tables give at the event's
 * time is taken as an estimate and any other as reported. Ambiguity resolves
 * toward `reported`: mislabelling an estimate only leaves it stale, which is
 * today's behavior, while mislabelling a reported cost would let a recalc
 * overwrite it.
 */
export function attributeCostSources(db: Database): number {
  return db.transaction(() => {
    let labelled = db.prepare(`
      UPDATE events SET cost_source = 'estimated'
      WHERE ${UNATTRIBUTED}
        AND ((source = 'import' AND agent_type IN ('codex', 'antigravity'))
          OR (source = 'otel' AND agent_type = 'codex'))
    `).run().changes;
    labelled += db.prepare(`
      UPDATE events SET cost_source = 'reported' WHERE ${UNATTRIBUTED} AND source = 'benchmark'
    `).run().changes;

    const rows = db.prepare(`
      SELECT id, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd,
             created_at, client_timestamp
      FROM events WHERE ${UNATTRIBUTED}
    `).all() as UnattributedRow[];
    const label = db.prepare('UPDATE events SET cost_source = ? WHERE id = ?');
    for (const row of rows) {
      const estimate = row.model
        ? pricingRegistry.calculate(row.model, {
            input: row.tokens_in,
            output: row.tokens_out,
            cacheRead: row.cache_read_tokens,
            cacheWrite: row.cache_write_tokens,
          }, row.client_timestamp ?? row.created_at)
        : null;
      label.run(estimate !== null && sameCost(row.cost_usd, estimate) ? 'estimated' : 'reported', row.id);
    }
    return labelled + rows.length;
  })();
}
