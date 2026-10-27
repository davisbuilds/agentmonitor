import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { getDb } from './connection.js';
import { CODEX_STREAM_EVENT_NAMES, isCodexStreamFragmentKind } from '../otel/parser.js';
import { recountProjectedSummaryMessages, restoreProjectedSessionBounds } from '../live/projector.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';
import { acquireRuntimeOwnership } from '../runtime-ownership.js';

export interface CodexFragmentPruneResult {
  /** Stored fragment events the inventory found (and, when applied, removed). */
  rows: number;
  sessions: number;
  /** Projected turns and items keyed by those events. */
  turns: number;
  items: number;
  /** sha256 of the sorted event row ids; an apply must present the preview's. */
  digest: string;
  applied: boolean;
}

interface Candidate {
  id: number;
  event_id: string | null;
  session_id: string;
  metadata: string | null;
}

/**
 * A stored row is a fragment only when it is exactly what the OTEL parser now
 * drops: a Codex OTEL `response` row with no usage or cost whose metadata holds
 * the two marker keys and nothing else. Any other key means the row carries
 * something, so it stays.
 */
function isStoredFragment(row: Candidate): boolean {
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata ?? '');
  } catch {
    return false;
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2 && keys[0] === 'event_kind' && keys[1] === 'otel_event_name'
    && typeof record.otel_event_name === 'string' && CODEX_STREAM_EVENT_NAMES.has(record.otel_event_name)
    && typeof record.event_kind === 'string' && isCodexStreamFragmentKind(record.event_kind);
}

function inventory() {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT id, event_id, session_id, metadata FROM events
    WHERE agent_type = 'codex' AND source = 'otel' AND event_type = 'response'
      AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
      AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_write_tokens, 0) = 0
      AND COALESCE(cost_usd, 0) = 0
    ORDER BY id
  `).all() as Candidate[];
  const fragments = candidates.filter(isStoredFragment);
  const turnsFor = db.prepare('SELECT id FROM session_turns WHERE session_id = ? AND source_turn_id = ?');
  const itemCount = db.prepare('SELECT COUNT(*) AS c FROM session_items WHERE turn_id = ?');
  let turns = 0;
  let items = 0;
  const hash = createHash('sha256');
  for (const row of fragments) {
    hash.update(`${row.id}\n`);
    // The summary projection keys an event's turn by its event id (see syncCodexSummaryLiveEvent).
    for (const turn of turnsFor.all(row.session_id, row.event_id ?? `codex-event:${row.id}`) as Array<{ id: number }>) {
      turns++;
      items += (itemCount.get(turn.id) as { c: number }).c;
    }
  }
  return { fragments, turns, items, digest: hash.digest('hex') };
}

/**
 * Remove stored Codex stream fragments: the content-free per-chunk OTEL rows
 * that predate the ingest filter, their projected turns and items, and their
 * share of each session's trace summary.
 *
 * Without `expectDigest` this is a read-only preview. With it, the prune takes
 * runtime ownership (so no server writes or caches meanwhile), recomputes the
 * inventory, refuses unless it matches the preview, and commits everything in
 * one transaction.
 */
export function pruneCodexStreamFragments(options: { dbPath: string; expectDigest?: string }): CodexFragmentPruneResult {
  const summarize = (plan: ReturnType<typeof inventory>, applied: boolean): CodexFragmentPruneResult => ({
    rows: plan.fragments.length,
    sessions: new Set(plan.fragments.map(row => row.session_id)).size,
    turns: plan.turns,
    items: plan.items,
    digest: plan.digest,
    applied,
  });
  if (options.expectDigest === undefined) return summarize(inventory(), false);

  const ownership = acquireRuntimeOwnership(options.dbPath);
  try {
    const db = getDb();
    if (fs.realpathSync(db.name) !== fs.realpathSync(options.dbPath)) {
      throw new Error('The open database is not the one whose ownership was taken');
    }
    const run = db.transaction(() => {
      const plan = inventory();
      if (plan.digest !== options.expectDigest) throw new Error('Fragment inventory changed; preview again');
      const turnsFor = db.prepare('SELECT id FROM session_turns WHERE session_id = ? AND source_turn_id = ?');
      const deleteItems = db.prepare('DELETE FROM session_items WHERE turn_id = ?');
      const deleteTurn = db.prepare('DELETE FROM session_turns WHERE id = ?');
      const deleteEvent = db.prepare('DELETE FROM events WHERE id = ?');
      for (const row of plan.fragments) {
        for (const turn of turnsFor.all(row.session_id, row.event_id ?? `codex-event:${row.id}`) as Array<{ id: number }>) {
          deleteItems.run(turn.id);
          deleteTurn.run(turn.id);
        }
        deleteEvent.run(row.id);
      }
      for (const sessionId of new Set(plan.fragments.map(row => row.session_id))) {
        recountProjectedSummaryMessages(db, sessionId);
        restoreProjectedSessionBounds(db, sessionId);
        maintainSessionTraceSummary(sessionId);
      }
      return summarize(plan, true);
    });
    return run.immediate();
  } finally {
    ownership.release();
  }
}
