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
  /** Of `rows_corrected`: rows whose 1-hour cache-write part was filled in or changed. */
  rows_split_1h: number;
  rows_ambiguous: number;
  rows_without_transcript: number;
  sessions_resummarized: number;
  tokens_reclaimed: number;
  /** Net cost removed; negative when billing 1-hour cache writes at their rate raises it. */
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
  cache_write_1h_tokens: number;
  cost_usd: number | null;
  cost_source: string | null;
  model: string | null;
  client_timestamp: string | null;
}

// input, output, cache read, cache write, and the 1-hour part of the cache write.
type Buckets = [number, number, number, number, number];

/**
 * Correct imported Claude Code rows that were billed once per content block
 * rather than once per assistant turn, and fill in the 1-hour part of their
 * cache writes where the transcript records it (rows imported before it was
 * read bill those writes at the 5-minute rate).
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
    rows_split_1h: 0,
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
  // The producer lines each transcript holds, to tell which copied which.
  const transcriptLines = new Map<string, Set<string>>();
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
    const lines = new Set<string>();
    transcriptLines.set(filePath, lines);
    const transcriptName = path.basename(filePath, '.jsonl');
    for (const event of parsed) {
      const buckets: Buckets = [
        event.tokens_in ?? 0,
        event.tokens_out ?? 0,
        event.cache_read_tokens ?? 0,
        event.cache_write_tokens ?? 0,
        event.cache_write_1h_tokens ?? 0,
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
          timestamp: event.client_timestamp ?? null,
          model: event.model ?? null,
        });
        claims.set(id, list);
      }
      if (isUuidId(event.event_id)) {
        const copies = copiesByLine.get(event.event_id) ?? [];
        copies.push({ legacyId: event.legacy_event_id, filePath, sessionId: event.session_id });
        copiesByLine.set(event.event_id, copies);
        lines.add(event.event_id);
      }
    }
  }

  // Pass 2: compare every stored import row against what its transcript says.
  const rows = db.prepare(`
    SELECT id, event_id, session_id, tokens_in, tokens_out, cache_read_tokens,
           cache_write_tokens, cache_write_1h_tokens, cost_usd, cost_source, model, client_timestamp
    FROM events
    WHERE source = 'import' AND agent_type = 'claude_code' AND event_id IS NOT NULL
  `).all() as StoredRow[];
  const storedRows = new Map(rows.map(row => [row.event_id, row]));
  const corrections = new Map<string, Buckets | null>();
  for (const [id, list] of claims) corrections.set(id, resolveClaims(id, list, storedRows));
  const { duplicates, unresolved } = duplicateLineRows(storedRows, corrections, copiesByLine, transcriptLines);

  const pending: Array<{ row: StoredRow; corrected: Buckets; cost: number | null }> = [];
  const touchedSessions = new Set<string>();

  for (const row of rows) {
    const hasUsage = rowHasUsage(row);
    if (unresolved.has(row.event_id)) {
      if (hasUsage) report.rows_ambiguous++;
      continue;
    }
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
      row.tokens_in, row.tokens_out, row.cache_read_tokens, row.cache_write_tokens, row.cache_write_1h_tokens,
    ];
    if (corrected.every((value, index) => value === stored[index])) continue;

    // A line that contributes no tokens also contributes no cost. A row that
    // now bills different tokens keeps a captured cost, but an estimate follows
    // the tokens it was estimated from.
    const zeroed = corrected.every(value => value === 0);
    const cost = zeroed ? 0 : correctedCost(row, corrected);

    report.rows_corrected++;
    if (duplicate) report.rows_deduplicated++;
    if (corrected[4] !== stored[4]) report.rows_split_1h++;
    // The 1-hour part is already counted in the cache-write total.
    report.tokens_reclaimed += stored.slice(0, 4).reduce((sum, value, index) => sum + (value - corrected[index]), 0);
    report.cost_reclaimed_usd += (row.cost_usd ?? 0) - (cost ?? 0);
    pending.push({ row, corrected, cost });
    touchedSessions.add(row.session_id);
  }

  report.cost_reclaimed_usd = Math.round(report.cost_reclaimed_usd * 1e10) / 1e10;

  if (apply && pending.length > 0) {
    const updateRow = db.prepare(`
      UPDATE events
      SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_write_tokens = ?, cache_write_1h_tokens = ?,
          cost_usd = ?
      WHERE id = ?
    `);
    const run = db.transaction(() => {
      for (const { row, corrected, cost } of pending) {
        updateRow.run(corrected[0], corrected[1], corrected[2], corrected[3], corrected[4], cost, row.id);
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

const ZERO: Buckets = [0, 0, 0, 0, 0];

function correctedCost(row: StoredRow, corrected: Buckets): number | null {
  if (row.cost_source !== 'estimated' || !row.model) return row.cost_usd;
  return pricingRegistry.calculate(row.model, {
    input: corrected[0],
    output: corrected[1],
    cacheRead: corrected[2],
    cacheWrite: corrected[3],
    cacheWrite1h: corrected[4],
  }, row.client_timestamp) ?? row.cost_usd;
}

/** One transcript line's claim on an id it can be stored under. */
interface Claim {
  buckets: Buckets;
  /** The claiming transcript is the session the id was minted for. */
  ownsId: boolean;
  /** The line's current id, when the claim is on its positional one. */
  ownId: string | undefined;
  timestamp: string | null;
  model: string | null;
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
 *   stored under its own id, so the row cannot be the only record of the child.
 *   Only token and cost columns are corrected, so a row the child wrote keeps
 *   the child's timestamp and model: it can be zeroed when the session's line
 *   bills nothing, but takes the session's tokens only if it is the session's
 *   own row.
 */
function resolveClaims(id: string, list: Claim[], storedRows: Map<string, StoredRow>): Buckets | null {
  const [first] = list;
  if (list.length === 1) return first.buckets;
  if (isUuidId(id)) return list.every(claim => sameBuckets(claim.buckets, first.buckets)) ? first.buckets : null;
  const owners = list.filter(claim => claim.ownsId);
  if (owners.length !== 1) return null;
  const [owner] = owners;
  const billedElsewhere = list.every(claim => claim.ownsId
    || claim.buckets.every(value => value === 0)
    || (claim.ownId !== undefined && storedRows.has(claim.ownId)));
  if (!billedElsewhere) return null;
  if (owner.buckets.every(value => value === 0)) return owner.buckets;
  const row = storedRows.get(id);
  const ownersRow = row !== undefined && row.client_timestamp === owner.timestamp && row.model === owner.model;
  return ownersRow ? owner.buckets : null;
}

/** One transcript's copy of a producer line. */
interface LineCopy {
  legacyId: string | undefined;
  filePath: string;
  /** The session the copy's transcript reports for the line. */
  sessionId: string;
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

/**
 * Rows that bill a producer line another row already bills, so the line counts
 * once however many rows hold it. Two histories store a line twice:
 *
 * - under both its uuid id and its transcript's positional id, when importers
 *   on either side of the id change each stored it;
 * - once per transcript, when a resumed session copies its predecessor's lines
 *   (same uuids, new session) and positional ids differ per file.
 *
 * The row kept is the one that belongs to the transcript the line came from.
 * Resuming copies the whole history, so the source is the transcript whose
 * lines all appear in every other transcript holding the line, each of which
 * also holds lines of its own. The source's uuid row is preferred over its
 * positional row; a uuid row another transcript stored does not count as the
 * source's. When no source can be established (the original was used again
 * after the resume), or the source has no stored row, the copies are
 * `unresolved` rather than guessed.
 *
 * Only lines whose transcripts agree on a non-zero contribution are considered,
 * and only ids no other line claims, so an ambiguous row is never the one kept
 * or the one zeroed.
 */
function duplicateLineRows(
  stored: Map<string, StoredRow>,
  corrections: Map<string, Buckets | null>,
  copiesByLine: Map<string, LineCopy[]>,
  transcriptLines: Map<string, Set<string>>,
): { duplicates: Set<string>; unresolved: Set<string> } {
  const duplicates = new Set<string>();
  const unresolved = new Set<string>();
  // A resumed transcript shares many lines with its source; compare each pair once.
  const lineage = new Map<string, boolean>();
  const isResumedFrom = (resumed: string, source: string): boolean => {
    const key = `${resumed}\0${source}`;
    let answer = lineage.get(key);
    if (answer === undefined) {
      answer = resumedFrom(transcriptLines.get(resumed), transcriptLines.get(source));
      lineage.set(key, answer);
    }
    return answer;
  };
  const eligible = (id: string | undefined, contribution: Buckets): id is string => {
    if (id === undefined || !stored.has(id)) return false;
    const claimed = corrections.get(id);
    return claimed !== undefined && claimed !== null && sameBuckets(claimed, contribution);
  };
  for (const [uuidId, copies] of copiesByLine) {
    const contribution = corrections.get(uuidId);
    if (contribution === null) {
      // The copies disagree on what the line contributes (a copy that starts
      // partway through a turn), so correcting each on its own could bill the
      // response twice. Leave every stored copy as it is.
      for (const copy of copies) {
        if (copy.legacyId !== undefined && stored.has(copy.legacyId)) unresolved.add(copy.legacyId);
      }
      continue;
    }
    if (!contribution || contribution.every(value => value === 0)) continue;
    const candidates = [...new Set([uuidId, ...copies.map(copy => copy.legacyId)])]
      .filter((id): id is string => eligible(id, contribution));
    if (candidates.length < 2) continue;

    const sources = copies.filter(copy => copies.every(other => other === copy
      || isResumedFrom(other.filePath, copy.filePath)));
    const source = sources.length === 1 ? sources[0] : undefined;
    const kept = source === undefined ? undefined
      : candidates.find(id => id === uuidId && stored.get(id)!.session_id === source.sessionId)
        ?? candidates.find(id => id === source.legacyId);
    if (kept === undefined) {
      for (const id of candidates) unresolved.add(id);
      continue;
    }
    // Every other copy is zeroed, including copies an earlier run already
    // zeroed; otherwise the ordinary correction would re-bill them.
    for (const id of candidates) if (id !== kept) duplicates.add(id);
  }
  return { duplicates, unresolved };
}

/** True when `resumed` holds every line of `source` and lines of its own. */
function resumedFrom(resumed: Set<string> | undefined, source: Set<string> | undefined): boolean {
  if (!resumed || !source || resumed.size <= source.size) return false;
  for (const line of source) if (!resumed.has(line)) return false;
  return true;
}
