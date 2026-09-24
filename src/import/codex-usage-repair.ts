import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { NormalizedIngestEvent } from '../contracts/event-contract.js';
import {
  getCodexOtelUsage,
  listImportedCodexRows,
  listImportedCodexSessionIds,
  type ImportedCodexRow,
} from '../db/queries.js';
import { discoverCodexLogs } from './codex.js';
import { importedRowMatches, reconciledEvent, sameCost } from './codex-reconcile.js';
import { readCodexRollout, reconcileCodexRollout, type CodexRolloutRead } from './index.js';

export interface CodexUsageRepairOptions {
  /** Root of the Codex installation holding `sessions/`. Defaults to `~/.codex`. */
  codexDir?: string;
  /** Write corrections. When false (the default) the scan only reports. */
  apply?: boolean;
  excludePatterns?: string[];
}

export interface CodexRepairFailure {
  rollout: string;
  error: string;
}

export interface CodexSubagentOtelCheck {
  session_id: string;
  ratio_before: number;
  ratio_after: number;
  otel_gap_hours: number;
}

type RowClass = 'copied_history' | 'orphaned' | 'refresh_drift' | 'repriced' | 'subagent_model' | 'annotated' | 'appended' | 'unclassified';

// A type alias, not an interface: `printSummary` takes `Record<string, unknown>`.
export type CodexUsageRepairReport = {
  apply: boolean;
  files_scanned: number;
  files_unreadable: number;
  sessions_unreconciled: number;
  sessions_without_rollout: number;
  sessions_changed: number;
  /** Sessions whose reconcile raised. Each rolled back on its own; rerunning finishes them. */
  sessions_failed: CodexRepairFailure[];
  subagent_boundaries_unresolved: number;
  inherited_counters_skipped: number;
  rows_inserted: number;
  rows_updated: number;
  rows_deleted: number;
  rows_by_class: Record<RowClass, number>;
  tokens_before: number;
  tokens_after: number;
  cost_before_usd: number;
  cost_after_usd: number;
  /** Changed non-subagent sessions whose repaired usage was compared with the rollout's own final counter. */
  counter_sessions_checked: number;
  /** Changed sessions skipped by that check because their counter drops mid-rollout, so the final counter understates them. */
  counter_sessions_reset: number;
  /** Checked sessions whose repaired usage does not equal the rollout's final counter. */
  counter_mismatches: string[];
  /** Changed subagent sessions compared with Codex OTEL. A plain session gets the counter check instead. */
  otel_sessions_checked: number;
  otel_ratios_moved_away: number;
  subagent_otel: CodexSubagentOtelCheck[];
  /** Sessions that had import usage and have none after the repair, so their OTEL rows count again. */
  sessions_left_without_usage: string[];
};

type Usage = { tokens: number; cost: number };

const tokensOf = (row: { tokens_in: number; tokens_out: number; cache_read_tokens?: number; cache_write_tokens?: number }) =>
  row.tokens_in + row.tokens_out + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);

function sameTokens(row: ImportedCodexRow, event: NormalizedIngestEvent): boolean {
  return row.tokens_in === event.tokens_in
    && row.tokens_out === event.tokens_out
    && row.cache_read_tokens === (event.cache_read_tokens ?? 0)
    && row.cache_write_tokens === (event.cache_write_tokens ?? 0);
}

/**
 * Name the evidence behind one row's change. The classes are the defects this
 * repair exists for, so a change that fits none of them is `unclassified`: an
 * unexplained difference the operator should look at before applying.
 */
function classifyUpdate(row: ImportedCodexRow, event: NormalizedIngestEvent): RowClass {
  const tokens = sameTokens(row, event);
  const cost = sameCost(row.cost_usd, event.cost_usd);
  const model = row.model === (event.model ?? null);
  if (tokens && model && !cost) return 'repriced';
  // The retired model refresh wrote the rollout's cost onto the old tokens.
  if (!tokens && cost) return 'refresh_drift';
  // A subagent's session model now comes from its own first turn, not its
  // parent's. Only session_start carries the boundary.
  if (tokens && cost && !model && metadataOf(event)._subagent_boundary === 'resolved') return 'subagent_model';
  if (tokens && cost && model) return 'annotated';
  return 'unclassified';
}

function metadataOf(event: NormalizedIngestEvent | undefined): Record<string, unknown> {
  const metadata = event?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
}

/**
 * Bring stored Codex import rows back in line with their rollouts.
 *
 * Every discoverable rollout is reconciled through the same path the importer
 * uses, so a repaired session is exactly what a fresh import would store. A
 * preview runs the same work and rolls it back. Each changed row is classified
 * by the evidence it carries, and each changed session is checked against an
 * instrument outside the parse: a plain session against the rollout's own final
 * cumulative counter, and a subagent, whose counter includes its parent's,
 * against Codex's per-request OTEL.
 *
 * Nothing is inferred from absence: a session whose rollout is gone, and a
 * rollout that cannot prove which session it owns, are counted and untouched.
 */
export function repairCodexImportUsage(
  _db: Database,
  options: CodexUsageRepairOptions = {},
): CodexUsageRepairReport {
  const apply = options.apply === true;
  const report: CodexUsageRepairReport = {
    apply,
    files_scanned: 0,
    files_unreadable: 0,
    sessions_unreconciled: 0,
    sessions_without_rollout: 0,
    sessions_changed: 0,
    sessions_failed: [],
    subagent_boundaries_unresolved: 0,
    inherited_counters_skipped: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_deleted: 0,
    rows_by_class: { copied_history: 0, orphaned: 0, refresh_drift: 0, repriced: 0, subagent_model: 0, annotated: 0, appended: 0, unclassified: 0 },
    tokens_before: 0,
    tokens_after: 0,
    cost_before_usd: 0,
    cost_after_usd: 0,
    counter_sessions_checked: 0,
    counter_sessions_reset: 0,
    counter_mismatches: [],
    otel_sessions_checked: 0,
    otel_ratios_moved_away: 0,
    subagent_otel: [],
    sessions_left_without_usage: [],
  };

  const seenSessions = new Set<string>();
  for (const filePath of discoverCodexLogs(options.codexDir, { excludePatterns: options.excludePatterns })) {
    report.files_scanned++;
    let read: CodexRolloutRead;
    try {
      read = readCodexRollout(filePath);
    } catch {
      report.files_unreadable++;
      continue;
    }
    // A failure past this point is not bad input: it is a repair that did not
    // happen. The session rolled back on its own, so the run continues, and
    // the failure is reported rather than counted as unreadable.
    let result: ReturnType<typeof reconcileCodexRollout>;
    let stored: ImportedCodexRow[] = [];
    try {
      // What is stored now, read before the reconcile changes it.
      const peek = reconcileCodexRollout(filePath, { apply: false, codexDir: options.codexDir }, read);
      if (peek.counts.session_id) stored = listImportedCodexRows(peek.counts.session_id);
      result = apply ? reconcileCodexRollout(filePath, { apply: true, codexDir: options.codexDir }, read) : peek;
    } catch (err) {
      report.sessions_failed.push({ rollout: path.basename(filePath), error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const { events, counts } = result;
    if (counts.session_id) seenSessions.add(counts.session_id);
    if (!counts.reconciled) {
      report.sessions_unreconciled++;
      continue;
    }

    const start = metadataOf(events.find(e => e.event_type === 'session_start'));
    const end = metadataOf(events.find(e => e.event_type === 'session_end'));
    const skipped = typeof end._inherited_counters_skipped === 'number' ? end._inherited_counters_skipped : 0;
    if (start._subagent_boundary === 'unresolved') report.subagent_boundaries_unresolved++;
    report.inherited_counters_skipped += skipped;

    if (counts.inserted + counts.updated + counts.deleted === 0) continue;
    report.sessions_changed++;
    report.rows_inserted += counts.inserted;
    report.rows_updated += counts.updated;
    report.rows_deleted += counts.deleted;

    const parsed = new Map<string, NormalizedIngestEvent>();
    for (const event of events) {
      if (event.event_id?.startsWith('import-cdx-') && !parsed.has(event.event_id)) parsed.set(event.event_id, event);
    }
    const storedById = new Map(stored.map(row => [row.event_id, row]));
    // What the reconcile wrote: a model known only from config keeps its stored value.
    for (const [id, event] of parsed) parsed.set(id, reconciledEvent(storedById.get(id), event));
    for (const row of stored) {
      const event = parsed.get(row.event_id);
      if (!event) report.rows_by_class[skipped > 0 ? 'copied_history' : 'orphaned']++;
      else if (!importedRowMatches(row, event)) report.rows_by_class[classifyUpdate(row, event)]++;
    }
    for (const id of parsed.keys()) if (!storedById.has(id)) report.rows_by_class.appended++;

    const before: Usage = stored.reduce((u, row) => ({ tokens: u.tokens + tokensOf(row), cost: u.cost + (row.cost_usd ?? 0) }), { tokens: 0, cost: 0 });
    const after: Usage = [...parsed.values()].reduce((u, e) => ({ tokens: u.tokens + tokensOf(e), cost: u.cost + (e.cost_usd ?? 0) }), { tokens: 0, cost: 0 });
    report.tokens_before += before.tokens;
    report.tokens_after += after.tokens;
    report.cost_before_usd += before.cost;
    report.cost_after_usd += after.cost;

    if (before.tokens > 0 && after.tokens === 0) report.sessions_left_without_usage.push(counts.session_id!);

    if (start._subagent_boundary === undefined) {
      // Without a reset, the rows telescope to the counter Codex itself kept.
      const finalCounter = Number(end.total_tokens_in ?? 0) + Number(end.total_tokens_out ?? 0);
      if (typeof end._counter_resets === 'number' && end._counter_resets > 0) report.counter_sessions_reset++;
      else {
        report.counter_sessions_checked++;
        if (after.tokens !== finalCounter) report.counter_mismatches.push(counts.session_id!);
      }
      continue;
    }

    const otel = getCodexOtelUsage(counts.session_id!);
    if (otel.tokens > 0) {
      report.otel_sessions_checked++;
      const ratioBefore = before.tokens / otel.tokens;
      const ratioAfter = after.tokens / otel.tokens;
      if (Math.abs(ratioAfter - 1) > Math.abs(ratioBefore - 1) + 1e-9) report.otel_ratios_moved_away++;
      const otelHours = new Set(otel.hours);
      const usageHours = new Set([...parsed.values()]
        .map(e => (tokensOf(e) > 0 ? Date.parse(e.client_timestamp ?? '') : Number.NaN))
        .filter(ms => Number.isFinite(ms))
        .map(ms => new Date(ms).toISOString().slice(0, 13)));
      report.subagent_otel.push({
        session_id: counts.session_id!,
        ratio_before: ratioBefore,
        ratio_after: ratioAfter,
        otel_gap_hours: [...usageHours].filter(hour => !otelHours.has(hour)).length,
      });
    }
  }

  report.sessions_without_rollout = listImportedCodexSessionIds().filter(id => !seenSessions.has(id)).length;
  return report;
}
