import type { Database } from 'better-sqlite3';
import { discoverClaudeCodeLogs, parseClaudeCodeFile } from './claude-code.js';

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
  rows_without_transcript: number;
  tokens_reclaimed: number;
  cost_reclaimed_usd: number;
};

interface StoredRow {
  id: number;
  event_id: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
}

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
 * Rows whose transcript no longer exists cannot be checked against a source and
 * are reported as `rows_without_transcript` rather than guessed at: event
 * history outlives the files it came from.
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
    rows_without_transcript: 0,
    tokens_reclaimed: 0,
    cost_reclaimed_usd: 0,
  };

  const selectRow = db.prepare(`
    SELECT id, event_id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd
    FROM events
    WHERE event_id = ? AND source = 'import' AND agent_type = 'claude_code'
  `);
  const updateRow = db.prepare(`
    UPDATE events
    SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?
    WHERE id = ?
  `);

  const seenEventIds = new Set<string>();
  const pending: Array<{ row: StoredRow; corrected: [number, number, number, number]; cost: number | null }> = [];

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
      if (!event.event_id) continue;
      seenEventIds.add(event.event_id);
      const row = selectRow.get(event.event_id) as StoredRow | undefined;
      if (!row) continue;
      report.rows_matched++;

      const corrected: [number, number, number, number] = [
        event.tokens_in ?? 0,
        event.tokens_out ?? 0,
        event.cache_read_tokens ?? 0,
        event.cache_write_tokens ?? 0,
      ];
      const stored: [number, number, number, number] = [
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
    }
  }

  report.cost_reclaimed_usd = Math.round(report.cost_reclaimed_usd * 1e10) / 1e10;

  const orphans = db.prepare(`
    SELECT id, event_id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd
    FROM events
    WHERE source = 'import' AND agent_type = 'claude_code' AND event_id IS NOT NULL
      AND (tokens_in > 0 OR tokens_out > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0)
  `).all() as StoredRow[];
  for (const row of orphans) {
    if (!seenEventIds.has(row.event_id)) report.rows_without_transcript++;
  }

  if (apply && pending.length > 0) {
    const run = db.transaction(() => {
      for (const { row, corrected, cost } of pending) {
        updateRow.run(corrected[0], corrected[1], corrected[2], corrected[3], cost, row.id);
      }
    });
    run();
  }

  return report;
}
