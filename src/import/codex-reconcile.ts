import type { NormalizedIngestEvent } from '../contracts/event-contract.js';
import { getDb } from '../db/connection.js';
import {
  deleteImportedCodexRows,
  insertEvent,
  listImportedCodexRows,
  resolveEventGitBranch,
  serializeEventMetadata,
  updateImportedCodexRow,
  type ImportedCodexRow,
} from '../db/queries.js';
import { syncCodexSummaryLiveEvent } from '../live/codex-adapter.js';
import {
  getBrowsingIntegrationMode,
  listProjectedTurnSourceIds,
  recountProjectedSummaryMessages,
  removeProjectedSourceEvent,
} from '../live/projector.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';

export interface CodexReconcileCounts {
  /** False when the parse cannot own the session's rows (no `session_meta`). */
  reconciled: boolean;
  session_id: string | null;
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

export interface CodexReconcileOptions {
  /** Write the result. When false the same work runs and is rolled back. */
  apply: boolean;
  /** Test seam: runs inside the session transaction after stale rows are deleted. */
  onAfterDelete?: () => void;
}

const PREVIEW_ROLLBACK = Symbol('codex-reconcile-preview');
const OWN_ID_PREFIX = 'import-cdx-';
// Browser rows the Codex summary projection owns. A full transcript projection
// under the same id must not be rewritten into a summary.
const SUMMARY_MODES = new Set(['codex-import', 'codex-otel', 'codex-summary']);

/** True when the stored row already says what the parse says. */
function rowMatches(row: ImportedCodexRow, event: NormalizedIngestEvent): boolean {
  return row.event_type === event.event_type
    && row.tool_name === (event.tool_name ?? null)
    && row.status === event.status
    && row.tokens_in === event.tokens_in
    && row.tokens_out === event.tokens_out
    && row.cache_read_tokens === (event.cache_read_tokens ?? 0)
    && row.cache_write_tokens === (event.cache_write_tokens ?? 0)
    && row.model === (event.model ?? null)
    && row.cost_usd === (event.cost_usd ?? null)
    && row.client_timestamp === (event.client_timestamp ?? null)
    && row.metadata === serializeEventMetadata(event.metadata);
}

/**
 * Make a Codex session's `import-cdx-` rows equal to its rollout's parse.
 *
 * The rollout is the only authority for these rows, and their ids are derived
 * from positions in it, so a rewritten rollout re-keys them: inserting only the
 * ids not yet stored left the old rows behind and refreshed cost onto stale
 * tokens. Here a row whose id the parse still produces is updated in place
 * (keeping its id and `created_at`), a row whose id it no longer produces is
 * deleted, and a new id is inserted. The event rows, their summary projection
 * and the trace summary change in one transaction, so an interrupted run leaves
 * the session wholly as it was.
 *
 * A parse without `session_meta` cannot prove which session it owns, and a
 * session whose browser row is a full transcript projection is not the summary
 * projection's to rewrite. Both are reported unreconciled and nothing is written.
 */
export function reconcileCodexImport(
  events: NormalizedIngestEvent[],
  options: CodexReconcileOptions,
): CodexReconcileCounts {
  // First occurrence wins, which is what insertion keeps: newer rollouts
  // repeat `session_meta`, and with it the session_start id.
  const parsed = new Map<string, NormalizedIngestEvent>();
  for (const event of events) {
    if (event.event_id?.startsWith(OWN_ID_PREFIX) && !parsed.has(event.event_id)) parsed.set(event.event_id, event);
  }
  const sessionId = parsed.values().next().value?.session_id ?? null;
  const counts: CodexReconcileCounts = {
    reconciled: false, session_id: sessionId, inserted: 0, updated: 0, deleted: 0, unchanged: 0,
  };
  const ownsSession = sessionId !== null
    && events.some(event => event.event_type === 'session_start')
    && [...parsed.values()].every(event => event.session_id === sessionId);
  if (!ownsSession) return counts;
  const browsingMode = getBrowsingIntegrationMode(getDb(), sessionId);
  if (browsingMode !== null && !SUMMARY_MODES.has(browsingMode)) return counts;
  counts.reconciled = true;

  // `git` must never run while this transaction holds the write lock.
  const stored = new Map(listImportedCodexRows(sessionId).map(row => [row.event_id, row]));
  const additions = [...parsed.values()].filter(event => !stored.has(event.event_id!));
  const newest = additions.at(-1);
  const gitBranch = options.apply && newest ? resolveEventGitBranch(newest) : null;

  const db = getDb();
  try {
    db.transaction(() => {
      const rows = new Map(listImportedCodexRows(sessionId).map(row => [row.event_id, row]));
      const touched = new Set<string>();
      const stale = [...rows.values()].filter(row => !parsed.has(row.event_id));
      deleteImportedCodexRows(stale.map(row => row.id));
      for (const row of stale) removeProjectedSourceEvent(db, sessionId, row.event_id);
      counts.deleted = stale.length;
      options.onAfterDelete?.();

      for (const event of parsed.values()) {
        const existing = rows.get(event.event_id!);
        if (!existing) {
          if (insertEvent({ ...event }, { gitBranch })) {
            counts.inserted++;
            touched.add(event.event_id!);
          }
          continue;
        }
        if (rowMatches(existing, event)) {
          counts.unchanged++;
          continue;
        }
        const updated = updateImportedCodexRow(existing.id, event);
        if (!updated) continue;
        counts.updated++;
        touched.add(existing.event_id);
        removeProjectedSourceEvent(db, sessionId, existing.event_id);
        syncCodexSummaryLiveEvent(db, updated);
      }

      if (counts.inserted + counts.updated + counts.deleted > 0) {
        recountProjectedSummaryMessages(db, sessionId);
        maintainSessionTraceSummary(sessionId);
        assertProjectionFollowsRows(sessionId, touched, stale.map(row => row.event_id));
      }
      if (!options.apply) throw PREVIEW_ROLLBACK;
    })();
  } catch (err) {
    if (err !== PREVIEW_ROLLBACK) throw err;
  }
  return counts;
}

/**
 * `insertEvent` logs a projection failure instead of raising it. Inside this
 * transaction that would commit rows without their projection, so check what
 * this run wrote and roll the session back on any mismatch. Rows imported
 * before the summary projection existed can lack one; they are not this run's
 * to project, so only the rows it touched are checked.
 */
function assertProjectionFollowsRows(sessionId: string, written: Set<string>, deleted: string[]): void {
  const projected = new Set(listProjectedTurnSourceIds(getDb(), sessionId));
  const missing = [...written].filter(id => !projected.has(id));
  const lingering = deleted.filter(id => projected.has(id));
  if (missing.length > 0 || lingering.length > 0) {
    throw new Error(
      `Codex projection for ${sessionId} does not follow its rows (${missing.length} missing, ${lingering.length} left behind)`,
    );
  }
}
