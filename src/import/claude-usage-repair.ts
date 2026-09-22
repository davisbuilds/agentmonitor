import type { Database } from 'better-sqlite3';
import { discoverClaudeCodeLogs, parseClaudeCodeFile } from './claude-code.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';

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
 * Two classes of row are reported rather than touched, because neither has an
 * unambiguous source to repair from:
 *
 * - `rows_without_transcript`: the file they came from is gone. Event history
 *   outlives its transcripts, and a missing source is not evidence of anything.
 * - `rows_ambiguous`: more than one transcript mints the same `event_id`. A
 *   child-agent transcript embeds its parent's `sessionId`, and ids derive from
 *   (session, line index), so parent and child collide on the same line number.
 *   Correcting from whichever file sorts later would write another transcript's
 *   tokens into the row.
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
    rows_ambiguous: 0,
    rows_without_transcript: 0,
    sessions_resummarized: 0,
    tokens_reclaimed: 0,
    cost_reclaimed_usd: 0,
  };

  // Pass 1: what each event id should contribute, and whether exactly one
  // transcript claims it. Ambiguity is decided before any row is read, so a
  // collision cannot depend on which file happened to be visited first.
  const corrections = new Map<string, Buckets | null>();
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
        if (corrections.has(id)) {
          corrections.set(id, null); // claimed twice: ambiguous
          continue;
        }
        corrections.set(id, buckets);
      }
    }
  }

  // Pass 2: compare every stored import row against what its transcript says.
  const rows = db.prepare(`
    SELECT id, event_id, session_id, tokens_in, tokens_out, cache_read_tokens,
           cache_write_tokens, cost_usd
    FROM events
    WHERE source = 'import' AND agent_type = 'claude_code' AND event_id IS NOT NULL
  `).all() as StoredRow[];

  const pending: Array<{ row: StoredRow; corrected: Buckets; cost: number | null }> = [];
  const touchedSessions = new Set<string>();

  for (const row of rows) {
    const hasUsage = row.tokens_in > 0 || row.tokens_out > 0
      || row.cache_read_tokens > 0 || row.cache_write_tokens > 0;
    const corrected = corrections.get(row.event_id);
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

    // A line that contributes no tokens also contributes no cost. Rows that
    // merely shift between buckets keep their captured cost untouched.
    const zeroed = corrected.every(value => value === 0);
    const cost = zeroed ? 0 : row.cost_usd;

    report.rows_corrected++;
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
