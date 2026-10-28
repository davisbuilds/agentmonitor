// One check of amon's imported totals against what each harness recorded
// itself, per recent session. Each source is checked against its own
// instrument, in its own unit:
//   - Claude: the `cost-state` checkpoint Claude Code writes into a transcript
//     (dollars, per model);
//   - Codex: the thread total on the rollout's last own `token_usage_record`
//     (tokens);
//   - Antigravity records no total of its own, and is reported as such.
// Read-only.

import fs from 'node:fs';
import { listImportedCodexRows } from '../db/queries.js';
import { checkClaudeTranscriptCosts } from './claude-cost-state.js';
import { discoverCodexLogs } from './codex.js';

export type SessionTotalSource = 'claude-code' | 'codex' | 'antigravity';

export type SessionTotalStatus =
  /** Compared: `harness`, `amon` and `ratio` are set. */
  | 'checked'
  /** Claude: the transcript holds no `cost-state` checkpoint. */
  | 'no_checkpoint'
  /** Claude: the checkpoint has no time to cut amon's rows at. */
  | 'no_cut'
  /** Codex: the rollout records no thread total (before Codex 0.154). */
  | 'no_thread_total'
  /** Codex: amon holds no imported usage for the session. */
  | 'not_imported';

export interface SessionTotalCheck {
  source: SessionTotalSource;
  session_id: string;
  status: SessionTotalStatus;
  /** The harness's own total, in the source's unit. */
  harness: number | null;
  /** amon's imported total for the same span, in the same unit. */
  amon: number | null;
  /** amon over the harness; null when either side cannot be compared. */
  ratio: number | null;
  /** Claude: the checkpoint window and per-model split. */
  detail?: Record<string, unknown>;
}

export interface SessionTotalSourceSummary {
  /** What the source is checked against; null when it records no total. */
  instrument: 'claude_cost_state' | 'codex_thread_total' | null;
  unit: 'usd' | 'tokens' | null;
  sessions: number;
  checked: number;
  ratio_min: number | null;
  ratio_median: number | null;
  ratio_max: number | null;
  /**
   * Claude only: the spread of each checked session's coverage, amon's cost over
   * the harness's own tokens at amon's rates, which cancels any disagreement in rates.
   */
  coverage_min?: number | null;
  coverage_median?: number | null;
  coverage_max?: number | null;
}

export interface SessionTotalReport {
  sources: Partial<Record<SessionTotalSource, SessionTotalSourceSummary>>;
  sessions: SessionTotalCheck[];
}

export interface SessionTotalCheckOptions {
  source: SessionTotalSource | 'all';
  claudeDir: string;
  /** Root of the Codex installation holding `sessions/`. Defaults to `~/.codex`. */
  codexDir?: string;
  /** Recent sessions per source, newest first. Defaults to 20. */
  limit?: number;
  excludePatterns?: string[];
}

const INSTRUMENTS: Record<SessionTotalSource, Pick<SessionTotalSourceSummary, 'instrument' | 'unit'>> = {
  'claude-code': { instrument: 'claude_cost_state', unit: 'usd' },
  codex: { instrument: 'codex_thread_total', unit: 'tokens' },
  antigravity: { instrument: null, unit: null },
};

export function checkSessionTotals(options: SessionTotalCheckOptions): SessionTotalReport {
  const limit = options.limit ?? 20;
  const wanted: SessionTotalSource[] = options.source === 'all' ? ['claude-code', 'codex', 'antigravity'] : [options.source];
  const report: SessionTotalReport = { sources: {}, sessions: [] };
  for (const source of wanted) {
    const checks = source === 'claude-code' ? checkClaude(options.claudeDir, limit)
      : source === 'codex' ? checkCodex(options.codexDir, limit, options.excludePatterns)
        : [];
    report.sources[source] = summarize(source, checks);
    report.sessions.push(...checks);
  }
  return report;
}

/** The min, median and max of the values, nulls left out; all null when none remain. */
function spread(values: Array<number | null | undefined>): [number | null, number | null, number | null] {
  const sorted = values.filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return [null, null, null];
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return [sorted[0], median, sorted[sorted.length - 1]];
}

function summarize(source: SessionTotalSource, checks: SessionTotalCheck[]): SessionTotalSourceSummary {
  const checked = checks.filter(check => check.status === 'checked');
  const [ratioMin, ratioMedian, ratioMax] = spread(checked.map(check => check.ratio));
  const summary: SessionTotalSourceSummary = {
    ...INSTRUMENTS[source],
    sessions: checks.length,
    checked: checked.length,
    ratio_min: ratioMin,
    ratio_median: ratioMedian,
    ratio_max: ratioMax,
  };
  if (source === 'claude-code') {
    [summary.coverage_min, summary.coverage_median, summary.coverage_max] = spread(checked.map(check => check.detail?.coverage as number | null));
  }
  return summary;
}

function checkClaude(claudeDir: string, limit: number): SessionTotalCheck[] {
  return checkClaudeTranscriptCosts({ claudeDir, limit }).map(check => ({
    source: 'claude-code',
    session_id: check.session_id,
    status: check.status,
    harness: check.harness_cost_usd,
    amon: check.amon_cost_usd,
    ratio: check.ratio,
    detail: {
      coverage: check.coverage,
      rate_ratio: check.rate_ratio,
      since: check.since,
      cut: check.cut,
      unpriced_rows: check.unpriced_rows,
      models: check.models,
      missing_models: check.missing_models,
      unimported_models: check.unimported_models,
    },
  }));
}

/** The session a rollout belongs to, and the thread total on its last own `token_usage_record`. */
function readThreadTotal(content: string): { sessionId: string | null; total: number | null } {
  let sessionId: string | null = null;
  let total: number | null = null;
  for (const raw of content.split('\n')) {
    // Most lines are neither; skip them before parsing.
    const meta = sessionId === null && raw.includes('"session_meta"');
    if (!meta && !raw.includes('"token_usage_record"')) continue;
    let line: { type?: unknown; payload?: Record<string, unknown> };
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      continue;
    }
    const payload = line.payload ?? {};
    if (line.type === 'session_meta' && sessionId === null && typeof payload.id === 'string') sessionId = payload.id;
    if (line.type !== 'token_usage_record' || sessionId === null || payload.thread_id !== sessionId) continue;
    const thread = payload.thread_token_usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    if (typeof thread?.input_tokens === 'number' && typeof thread.output_tokens === 'number') {
      total = thread.input_tokens + thread.output_tokens;
    }
  }
  return { sessionId, total };
}

function checkCodex(codexDir: string | undefined, limit: number, excludePatterns: string[] | undefined): SessionTotalCheck[] {
  const recent = discoverCodexLogs(codexDir, { excludePatterns })
    .flatMap(file => {
      try {
        return [{ file, mtime: fs.statSync(file).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const checks: SessionTotalCheck[] = [];
  for (const { file } of recent) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const { sessionId, total } = readThreadTotal(content);
    if (sessionId === null) continue;
    const empty = { harness: null, amon: null, ratio: null };
    if (total === null) {
      checks.push({ source: 'codex', session_id: sessionId, status: 'no_thread_total', ...empty });
      continue;
    }
    const rows = listImportedCodexRows(sessionId);
    if (rows.length === 0) {
      checks.push({ source: 'codex', session_id: sessionId, status: 'not_imported', ...empty, harness: total });
      continue;
    }
    // Cache-inclusive input plus output, as Codex's thread total counts it.
    const amon = rows.reduce((sum, row) => sum + row.tokens_in + row.tokens_out + row.cache_read_tokens + row.cache_write_tokens, 0);
    checks.push({ source: 'codex', session_id: sessionId, status: 'checked', harness: total, amon, ratio: total > 0 ? amon / total : null });
  }
  return checks;
}
