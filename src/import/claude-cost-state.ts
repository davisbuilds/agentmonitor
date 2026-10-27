import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';

export interface ClaudeCostStateModel {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Claude Code's own running totals, as its latest `cost-state` line in a transcript records them. */
export interface ClaudeCostStateCheckpoint {
  /**
   * The checkpoint's time. `cost-state` lines carry none, so this is the
   * timestamp of the nearest timestamped line before it; null when there is none.
   */
  cut: string | null;
  /**
   * When the totals start: the cost tracker's own `startTime`. A resumed process
   * that restores the session's cost state keeps the original start; one that
   * does not starts from zero at its own. Null when the line carries none.
   */
  since: string | null;
  total_cost_usd: number;
  models: Record<string, ClaudeCostStateModel>;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The latest `cost-state` in a Claude Code transcript. Claude Code writes one
 * when a process exits or resumes, holding the session's running cost per
 * model, subagents included, so it is a checkpoint rather than a live meter.
 */
export function readLatestCostState(content: string): ClaudeCostStateCheckpoint | null {
  let lastTimestamp: string | null = null;
  let latest: ClaudeCostStateCheckpoint | null = null;
  for (const raw of content.split('\n')) {
    if (!raw) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (line.type === 'cost-state') {
      const models: Record<string, ClaudeCostStateModel> = {};
      const usage = line.modelUsage;
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        for (const [model, value] of Object.entries(usage as Record<string, Record<string, unknown>>)) {
          models[model] = {
            cost_usd: num(value?.costUSD),
            input_tokens: num(value?.inputTokens),
            output_tokens: num(value?.outputTokens),
            cache_read_tokens: num(value?.cacheReadInputTokens),
            cache_write_tokens: num(value?.cacheCreationInputTokens),
          };
        }
      }
      const startTime = typeof line.startTime === 'number' && Number.isFinite(line.startTime) ? new Date(line.startTime) : null;
      latest = {
        cut: lastTimestamp,
        since: startTime && !Number.isNaN(startTime.getTime()) ? startTime.toISOString() : null,
        total_cost_usd: num(line.totalCostUSD),
        models,
      };
      continue;
    }
    if (typeof line.timestamp === 'string') lastTimestamp = line.timestamp;
  }
  return latest;
}

export interface ClaudeModelCostCheck {
  model: string;
  harness_cost_usd: number;
  amon_cost_usd: number;
  /** amon over the harness; null when the harness billed nothing or amon holds unpriced rows. */
  ratio: number | null;
}

export interface ClaudeTranscriptCostCheck {
  session_id: string;
  /**
   * `no_checkpoint`: the transcript holds no `cost-state`; `no_cut`: nothing
   * timestamped precedes it, or it does not say when its totals start.
   */
  status: 'checked' | 'no_checkpoint' | 'no_cut';
  since: string | null;
  cut: string | null;
  harness_cost_usd: number | null;
  amon_cost_usd: number | null;
  ratio: number | null;
  unpriced_rows: number;
  models: ClaudeModelCostCheck[];
  /** Models the harness billed that amon holds no rows for up to the cut. */
  missing_models: string[];
}

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Top-level session transcripts, newest first. Subagent transcripts live below a session and are skipped. */
function recentSessionFiles(claudeDir: string, limit: number): string[] {
  const projectsDir = path.join(claudeDir, 'projects');
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }
  const files: Array<{ file: string; mtime: number }> = [];
  for (const project of projects) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(projectsDir, project), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
      const file = path.join(projectsDir, project, entry.name);
      files.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(entry => entry.file);
}

/**
 * The latest sessions' Claude Code cost at their last `cost-state` checkpoint
 * beside amon's imported cost for the same session up to that point, per model.
 * Read-only. A model the harness billed that amon has no rows for is usage the
 * transcript never recorded, such as side requests on a smaller model.
 */
export function checkClaudeTranscriptCosts(options: { claudeDir: string; limit?: number }): ClaudeTranscriptCostCheck[] {
  const db = getDb();
  const perModel = db.prepare(`
    SELECT model, COALESCE(SUM(cost_usd), 0) AS cost,
      SUM(CASE WHEN cost_usd IS NULL
        AND (tokens_in > 0 OR tokens_out > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0) THEN 1 ELSE 0 END) AS unpriced
    FROM events
    WHERE session_id = ? AND agent_type = 'claude_code' AND source = 'import'
      AND client_timestamp >= ? AND client_timestamp <= ?
    GROUP BY model
  `);
  return recentSessionFiles(options.claudeDir, options.limit ?? 20).map((file): ClaudeTranscriptCostCheck => {
    const sessionId = path.basename(file, '.jsonl');
    const checkpoint = readLatestCostState(fs.readFileSync(file, 'utf-8'));
    const empty = { harness_cost_usd: null, amon_cost_usd: null, ratio: null, unpriced_rows: 0, models: [], missing_models: [] };
    if (!checkpoint) return { session_id: sessionId, status: 'no_checkpoint', since: null, cut: null, ...empty };
    if (!checkpoint.cut || !checkpoint.since) {
      return { session_id: sessionId, status: 'no_cut', since: checkpoint.since, cut: checkpoint.cut, ...empty };
    }

    const rows = perModel.all(sessionId, checkpoint.since, checkpoint.cut) as Array<{ model: string | null; cost: number; unpriced: number }>;
    const amon = new Map(rows.map(row => [row.model ?? '', row]));
    const unpricedRows = rows.reduce((sum, row) => sum + row.unpriced, 0);
    // An unpriced row bills as NULL and the sum skips it, so the imported cost
    // would read low; no ratio is better than a falsely reassuring one.
    const ratio = (amonCost: number, harnessCost: number, unpriced: number) =>
      (harnessCost > 0 && unpriced === 0 ? amonCost / harnessCost : null);
    const models = Object.entries(checkpoint.models).map(([model, usage]) => {
      const row = amon.get(model);
      return {
        model,
        harness_cost_usd: usage.cost_usd,
        amon_cost_usd: row?.cost ?? 0,
        ratio: ratio(row?.cost ?? 0, usage.cost_usd, row?.unpriced ?? 0),
      };
    });
    const amonCost = rows.reduce((sum, row) => sum + row.cost, 0);
    return {
      session_id: sessionId,
      status: 'checked',
      since: checkpoint.since,
      cut: checkpoint.cut,
      harness_cost_usd: checkpoint.total_cost_usd,
      amon_cost_usd: amonCost,
      ratio: ratio(amonCost, checkpoint.total_cost_usd, unpricedRows),
      unpriced_rows: unpricedRows,
      models,
      missing_models: models.filter(model => model.harness_cost_usd > 0 && !amon.has(model.model)).map(model => model.model),
    };
  });
}
