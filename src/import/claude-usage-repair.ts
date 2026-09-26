import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { discoverClaudeCodeLogs, parseClaudeCodeFile } from './claude-code.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';
import { pricingRegistry } from '../pricing/index.js';

export interface ClaudeUsageRepairOptions {
  /** Root of the Claude installation holding `projects/`. Defaults to `~/.claude`. */
  claudeDir?: string;
  /** Write corrections. When false (the default) the scan only reports. */
  apply?: boolean;
  excludePatterns?: string[];
}

// A type alias, not an interface: `printSummary` takes `Record<string, unknown>`,
// which an interface is not assignable to.
export type ClaudeUsageRepairReport = {
  apply: boolean;
  files_scanned: number;
  rows_matched: number;
  rows_corrected: number;
  /** Of `rows_corrected`: rows zeroed because another row already bills the same producer line. */
  rows_deduplicated: number;
  rows_ambiguous: number;
  rows_without_transcript: number;
  sessions_resummarized: number;
  tokens_reclaimed: number;
  cost_reclaimed_usd: number;
};

interface StoredRow {
  id: number;
  event_id: string;
  session_id: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  cost_source: string | null;
  model: string | null;
  client_timestamp: string | null;
}

type Buckets = [number, number, number, number];

/**
 * Correct imported Claude Code rows that were billed once per content block
 * rather than once per assistant turn.
 *
 * The transcript is the authority: each file is re-parsed with the corrected
 * parser and the stored row for a given `event_id` is aligned to what that line
 * should have contributed. Rows are never deleted — a repeat line of a turn
 * keeps its event and loses only the usage it double-counted — so transcripts,
 * event history and tool-call projections are unaffected.
 *
 * A producer line is billed once however many rows hold it: a line stored
 * under both its uuid id and its positional id, or copied into a resumed
 * session's transcript, keeps one billing row and the rest are zeroed
 * (`rows_deduplicated`).
 *
 * Two classes of row are reported rather than touched, because neither has an
 * unambiguous source to repair from:
 *
 * - `rows_without_transcript`: the file they came from is gone. Event history
 *   outlives its transcripts, and a missing source is not evidence of anything.
 * - `rows_ambiguous`: transcripts disagree on what the `event_id` holds. A
 *   child-agent transcript embeds its parent's `sessionId`, and positional ids
 *   derive from (session, line index), so parent and child collide on the same
 *   line number. The id is the parent's once the child's line has a row of its
 *   own; until then the row may be the child's only record, and correcting it
 *   from the parent would drop the child's tokens.
 */
export function repairClaudeImportUsage(
  db: Database,
  options: ClaudeUsageRepairOptions = {},
): ClaudeUsageRepairReport {
  const apply = options.apply === true;
  const report: ClaudeUsageRepairReport = {
    apply,
    files_scanned: 0,
    rows_matched: 0,
    rows_corrected: 0,
    rows_deduplicated: 0,
    rows_ambiguous: 0,
    rows_without_transcript: 0,
    sessions_resummarized: 0,
    tokens_reclaimed: 0,
    cost_reclaimed_usd: 0,
  };

  // Pass 1: every transcript line's claim on each id it can be stored under.
  // Claims are collected before any is resolved, so a collision cannot depend
  // on which file happened to be visited first.
  const claims = new Map<string, Claim[]>();
  // Every copy of a producer line (keyed by its uuid id), for billing it once.
  const copiesByLine = new Map<string, LineCopy[]>();
  for (const filePath of discoverClaudeCodeLogs(options.claudeDir, {
    excludePatterns: options.excludePatterns,
  })) {
    report.files_scanned++;
    let parsed;
    try {
      parsed = parseClaudeCodeFile(filePath);
    } catch {
      continue; // an unreadable transcript leaves its rows unrepairable, not wrong
    }
    const transcriptEnd = latestTimestamp(parsed);
    const transcriptName = path.basename(filePath, '.jsonl');
    for (const event of parsed) {
      const buckets: Buckets = [
        event.tokens_in ?? 0,
        event.tokens_out ?? 0,
        event.cache_read_tokens ?? 0,
        event.cache_write_tokens ?? 0,
      ];
      // Index under both ids a line can be stored as: the current one, and the
      // positional id every row imported before the uuid change still carries.
      // Legacy ids are the ones that collide between a transcript and its
      // child-agent file, so the ambiguity rule does its work here.
      // A line without a uuid derives both ids identically; indexing it twice
      // would mark it as claimed by two files and refuse to repair it.
      for (const id of new Set([event.event_id, event.legacy_event_id])) {
        if (!id) continue;
        const list = claims.get(id) ?? [];
        list.push({
          buckets,
          // A transcript is named after its session and owns the positional ids
          // minted for it; a child agent's file reports its parent's session.
          ownsId: transcriptName === event.session_id,
          ownId: id === event.event_id ? undefined : event.event_id,
        });
        claims.set(id, list);
      }
      if (isUuidId(event.event_id)) {
        const copies = copiesByLine.get(event.event_id) ?? [];
        copies.push({ legacyId: event.legacy_event_id, transcriptEnd, filePath });
        copiesByLine.set(event.event_id, copies);
      }
    }
  }

  // Pass 2: compare every stored import row against what its transcript says.
  const rows = db.prepare(`
    SELECT id, event_id, session_id, tokens_in, tokens_out, cache_read_tokens,
           cache_write_tokens, cost_usd, cost_source, model, client_timestamp
    FROM events
    WHERE source = 'import' AND agent_type = 'claude_code' AND event_id IS NOT NULL
  `).all() as StoredRow[];
  const storedIds = new Set(rows.map(row => row.event_id));
  const corrections = new Map<string, Buckets | null>();
  for (const [id, list] of claims) corrections.set(id, resolveClaims(id, list, storedIds));
  const duplicates = duplicateLineRows(storedIds, corrections, copiesByLine);

  const pending: Array<{ row: StoredRow; corrected: Buckets; cost: number | null }> = [];
  const touchedSessions = new Set<string>();

  for (const row of rows) {
    const hasUsage = rowHasUsage(row);
    const duplicate = duplicates.has(row.event_id);
    const corrected = duplicate ? ZERO : corrections.get(row.event_id);
    if (corrected === undefined) {
      if (hasUsage) report.rows_without_transcript++;
      continue;
    }
    if (corrected === null) {
      if (hasUsage) report.rows_ambiguous++;
      continue;
    }
    report.rows_matched++;

    const stored: Buckets = [
      row.tokens_in, row.tokens_out, row.cache_read_tokens, row.cache_write_tokens,
    ];
    if (corrected.every((value, index) => value === stored[index])) continue;

    // A line that contributes no tokens also contributes no cost. A row that
    // now bills different tokens keeps a captured cost, but an estimate follows
    // the tokens it was estimated from.
    const zeroed = corrected.every(value => value === 0);
    const cost = zeroed ? 0 : correctedCost(row, corrected);

    report.rows_corrected++;
    if (duplicate) report.rows_deduplicated++;
    report.tokens_reclaimed += stored.reduce((sum, value, index) => sum + (value - corrected[index]), 0);
    report.cost_reclaimed_usd += (row.cost_usd ?? 0) - (cost ?? 0);
    pending.push({ row, corrected, cost });
    touchedSessions.add(row.session_id);
  }

  report.cost_reclaimed_usd = Math.round(report.cost_reclaimed_usd * 1e10) / 1e10;

  if (apply && pending.length > 0) {
    const updateRow = db.prepare(`
      UPDATE events
      SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?
      WHERE id = ?
    `);
    const run = db.transaction(() => {
      for (const { row, corrected, cost } of pending) {
        updateRow.run(corrected[0], corrected[1], corrected[2], corrected[3], cost, row.id);
      }
    });
    run();

    // session_trace_summary keeps its own token/cost rollup, which the
    // trace-quality API and warehouse export read directly. Startup backfill
    // skips rows already at the current projection version, so a repaired
    // session would otherwise keep serving the inflated numbers indefinitely.
    for (const sessionId of touchedSessions) {
      maintainSessionTraceSummary(sessionId);
      report.sessions_resummarized++;
    }
  }

  return report;
}

const ZERO: Buckets = [0, 0, 0, 0];

function correctedCost(row: StoredRow, corrected: Buckets): number | null {
  if (row.cost_source !== 'estimated' || !row.model) return row.cost_usd;
  return pricingRegistry.calculate(row.model, {
    input: corrected[0],
    output: corrected[1],
    cacheRead: corrected[2],
    cacheWrite: corrected[3],
  }, row.client_timestamp) ?? row.cost_usd;
}

/** One transcript line's claim on an id it can be stored under. */
interface Claim {
  buckets: Buckets;
  /** The claiming transcript is the session the id was minted for. */
  ownsId: boolean;
  /** The line's current id, when the claim is on its positional one. */
  ownId: string | undefined;
}

/**
 * What a row stored under `id` should hold, or null when the claims leave that
 * undecidable.
 *
 * - One claim decides it.
 * - A uuid id names one producer line, so a resumed session's copy of it is
 *   the same line, not a collision — unless the copies disagree.
 * - A positional id minted for a session and also by that session's child
 *   agents belongs to the session once every child line that bills something is
 *   stored under its own id: the row cannot be the only record of the child.
 */
function resolveClaims(id: string, list: Claim[], storedIds: Set<string>): Buckets | null {
  const [first] = list;
  if (list.length === 1) return first.buckets;
  if (isUuidId(id)) return list.every(claim => sameBuckets(claim.buckets, first.buckets)) ? first.buckets : null;
  const owners = list.filter(claim => claim.ownsId);
  const billedElsewhere = list.every(claim => claim.ownsId
    || claim.buckets.every(value => value === 0)
    || (claim.ownId !== undefined && storedIds.has(claim.ownId)));
  return owners.length === 1 && billedElsewhere ? owners[0].buckets : null;
}

/** One transcript's copy of a producer line. */
interface LineCopy {
  legacyId: string | undefined;
  /** When the transcript holding this copy last wrote, as epoch ms. */
  transcriptEnd: number;
  filePath: string;
}

function isUuidId(id: string | undefined): id is string {
  return id?.startsWith('import-ccu-') === true;
}

function sameBuckets(a: Buckets, b: Buckets): boolean {
  return a.every((value, index) => value === b[index]);
}

function rowHasUsage(row: StoredRow): boolean {
  return row.tokens_in > 0 || row.tokens_out > 0 || row.cache_read_tokens > 0 || row.cache_write_tokens > 0;
}

function latestTimestamp(events: Array<{ client_timestamp?: string }>): number {
  let latest = -Infinity;
  for (const event of events) {
    const time = event.client_timestamp ? Date.parse(event.client_timestamp) : NaN;
    if (time > latest) latest = time;
  }
  return latest;
}

/**
 * Rows that bill a producer line another row already bills, so the line counts
 * once however many rows hold it. Two histories store a line twice:
 *
 * - under both its uuid id and its transcript's positional id, when importers
 *   on either side of the id change each stored it;
 * - once per transcript, when a resumed session copies its predecessor's lines
 *   (same uuids, new session) and positional ids differ per file.
 *
 * The row kept is the uuid row when there is one, otherwise the copy in the
 * transcript that finished first: a resumed session's transcript runs past the
 * one it copied. Only lines whose transcripts agree on a non-zero contribution
 * are considered, and only ids no other line claims, so an ambiguous row is
 * never the one kept or the one zeroed.
 */
function duplicateLineRows(
  stored: Set<string>,
  corrections: Map<string, Buckets | null>,
  copiesByLine: Map<string, LineCopy[]>,
): Set<string> {
  const duplicates = new Set<string>();
  for (const [uuidId, copies] of copiesByLine) {
    const contribution = corrections.get(uuidId);
    if (!contribution || contribution.every(value => value === 0)) continue;
    const ordered = [...copies].sort((a, b) =>
      a.transcriptEnd - b.transcriptEnd || a.filePath.localeCompare(b.filePath));
    const candidates = [...new Set([uuidId, ...ordered.map(copy => copy.legacyId)])]
      .filter((id): id is string => id !== undefined && stored.has(id))
      .filter(id => {
        const claimed = corrections.get(id);
        return claimed !== undefined && claimed !== null && sameBuckets(claimed, contribution);
      });
    // Every copy but the first is zeroed, including copies an earlier run already
    // zeroed; otherwise the ordinary correction would re-bill them.
    for (const id of candidates.slice(1)) duplicates.add(id);
  }
  return duplicates;
}
