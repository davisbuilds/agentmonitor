import { getDb } from '../db/connection.js';
import type {
  CountResult,
  TraceQualityObservation,
  TraceQualityObservationDetail,
  TraceQualityObservationListParams,
  TraceQualityObservationTreeNode,
  TraceQualityPromptRef,
  TraceQualityPromptRollup,
  TraceQualityReadCoverage,
  TraceQualityScore,
  TraceQualityScoreCoverage,
  TraceQualityScoreRollup,
  TraceQualityScoreRollupDimension,
  TraceQualityScoreRollups,
  TraceQualityScoreListParams,
  TraceQualityScoreSummary,
  TraceQualityTrace,
  TraceQualityTraceDetail,
  TraceQualityTraceListParams,
} from '../api/v2/types.js';
import type {
  TraceQualityObservationRow,
  TraceQualityPromptRefRow,
  TraceQualityScoreRow,
  TraceQualityTraceRow,
} from './types.js';

interface TraceQualityTraceSqlRow extends TraceQualityTraceRow {
  observation_count: number | null;
  error_count: number | null;
  total_tokens_in: number | null;
  total_tokens_out: number | null;
  total_cache_read_tokens: number | null;
  total_cache_write_tokens: number | null;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  first_observation_at: string | null;
  last_observation_at: string | null;
  score_count: number | null;
  numeric_score_avg: number | null;
}

interface PromptRefSqlRow extends TraceQualityPromptRefRow {
  observation_count: number;
  trace_count: number;
  latest_observation_at?: string | null;
}

interface PromptRollupSqlRow extends PromptRefSqlRow {
  generation_count: number | null;
  total_cost_usd: number | null;
  total_tokens_in: number | null;
  total_tokens_out: number | null;
  duration_values: string | null;
}

interface PromptScoreMetricSqlRow {
  prompt_ref_id: number;
  score_id: number;
  numeric_value: number | null;
}

interface ScoreSummarySqlRow {
  name: string;
  value_type: string;
  count: number;
  numeric_avg: number | null;
  numeric_min: number | null;
  numeric_max: number | null;
  boolean_true: number | null;
  boolean_false: number | null;
  scored_traces: number;
}

interface CategoryCountSqlRow {
  name: string;
  value_type: string;
  categorical_value: string;
  c: number;
}

interface ScoreRollupSqlRow {
  key: string;
  label: string | null;
  score_count: number;
  numeric_score_count: number | null;
  numeric_avg: number | null;
  boolean_true: number | null;
  boolean_false: number | null;
  trace_count: number;
  observation_count: number;
  first_score_at: string | null;
  last_score_at: string | null;
}

interface ScoreRollupCategorySqlRow {
  key: string;
  categorical_value: string;
  c: number;
}

export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizedLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

export function normalizedOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function median(values: readonly number[]): number | null {
  const sorted = values
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;

  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  return left == null || right == null ? null : (left + right) / 2;
}

function parseNumberList(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map(entry => Number(entry))
    .filter(entry => Number.isFinite(entry));
}

export function addDaysToDateString(date: string, days: number): string | null {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function lowCoverageExpr(alias = 't'): string {
  return `COALESCE(json_extract(${alias}.coverage_json, '$.projection_confidence'), 'unknown') IN ('low', 'unknown')`;
}

function observationHasUsageExpr(alias = 'o'): string {
  return `(
    COALESCE(${alias}.tokens_in, 0) > 0
    OR COALESCE(${alias}.tokens_out, 0) > 0
    OR COALESCE(${alias}.cache_read_tokens, 0) > 0
    OR COALESCE(${alias}.cache_write_tokens, 0) > 0
    OR ${alias}.cost_usd IS NOT NULL
  )`;
}

export function traceScoreTargetSql(): string {
  return `
    SELECT
      s.*,
      CASE
        WHEN s.target_type = 'trace' THEN s.target_id
        WHEN s.target_type = 'observation' THEN so.trace_id
        ELSE NULL
      END AS resolved_trace_id,
      CASE
        WHEN s.target_type = 'session' THEN s.target_id
        WHEN s.target_type = 'trace' THEN st.session_id
        WHEN s.target_type = 'observation' THEN so.session_id
        WHEN s.target_type = 'event' THEN se.session_id
        WHEN s.target_type = 'message' THEN sm.session_id
        WHEN s.target_type = 'session_item' THEN si.session_id
        ELSE NULL
      END AS resolved_session_id,
      CASE
        WHEN s.target_type = 'observation' THEN s.target_id
        ELSE NULL
      END AS resolved_observation_id
    FROM trace_quality_scores s
    LEFT JOIN trace_quality_traces st
      ON s.target_type = 'trace'
     AND s.target_id = st.id
    LEFT JOIN trace_quality_observations so
      ON s.target_type = 'observation'
     AND s.target_id = so.id
    LEFT JOIN events se
      ON s.target_type = 'event'
     AND (s.target_id = CAST(se.id AS TEXT) OR s.target_id = se.event_id)
    LEFT JOIN messages sm
      ON s.target_type = 'message'
     AND s.target_id = CAST(sm.id AS TEXT)
    LEFT JOIN session_items si
      ON s.target_type = 'session_item'
     AND (s.target_id = CAST(si.id AS TEXT) OR s.target_id = si.source_item_id)
  `;
}

export function appendDateRangeConditions(
  conditions: string[],
  values: unknown[],
  column: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): void {
  if (dateFrom) {
    conditions.push(`datetime(${column}) >= datetime(?)`);
    values.push(dateFrom);
  }
  if (dateTo) {
    const nextDay = /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? addDaysToDateString(dateTo, 1) : null;
    if (nextDay) {
      conditions.push(`datetime(${column}) < datetime(?)`);
      values.push(nextDay);
    } else {
      conditions.push(`datetime(${column}) <= datetime(?)`);
      values.push(dateTo);
    }
  }
}

function appendScoreExistsFilter(conditions: string[], values: unknown[], params: TraceQualityTraceListParams): void {
  const scoreConditions: string[] = [];
  if (params.score_name) {
    scoreConditions.push('fs.name = ?');
    values.push(params.score_name);
  }
  if (params.min_score != null) {
    scoreConditions.push('fs.numeric_value >= ?');
    values.push(params.min_score);
  }
  if (params.max_score != null) {
    scoreConditions.push('fs.numeric_value <= ?');
    values.push(params.max_score);
  }
  if (scoreConditions.length === 0) return;

  conditions.push(`
    EXISTS (
      SELECT 1
      FROM trace_quality_scores fs
      LEFT JOIN trace_quality_observations fso
        ON fs.target_type = 'observation'
       AND fs.target_id = fso.id
      LEFT JOIN events fse
        ON fs.target_type = 'event'
       AND (fs.target_id = CAST(fse.id AS TEXT) OR fs.target_id = fse.event_id)
      LEFT JOIN messages fsm
        ON fs.target_type = 'message'
       AND fs.target_id = CAST(fsm.id AS TEXT)
      LEFT JOIN session_items fsi
        ON fs.target_type = 'session_item'
       AND (fs.target_id = CAST(fsi.id AS TEXT) OR fs.target_id = fsi.source_item_id)
      WHERE (
          (fs.target_type = 'trace' AND fs.target_id = t.id)
          OR (fs.target_type = 'observation' AND fso.trace_id = t.id)
          OR (fs.target_type = 'session' AND fs.target_id = t.session_id)
          OR (fs.target_type = 'event' AND fse.session_id = t.session_id)
          OR (fs.target_type = 'message' AND fsm.session_id = t.session_id)
          OR (fs.target_type = 'session_item' AND fsi.session_id = t.session_id)
        )
        AND ${scoreConditions.join(' AND ')}
    )
  `);
}

function buildTraceWhere(
  params: TraceQualityTraceListParams = {},
  options: { applyLowCoverageExclusion?: boolean } = {},
): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];

  appendDateRangeConditions(conditions, values, 'COALESCE(t.started_at, t.created_at)', params.date_from, params.date_to);
  if (params.project) {
    conditions.push('t.project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('t.agent_type = ?');
    values.push(params.agent);
  }
  if (params.status) {
    conditions.push('t.status = ?');
    values.push(params.status);
  }
  if (params.observation_type || params.model || params.tool || params.tool_name) {
    const observationConditions: string[] = [];
    if (params.observation_type) {
      observationConditions.push('fo.observation_type = ?');
      values.push(params.observation_type);
    }
    if (params.model) {
      observationConditions.push('fo.model = ?');
      values.push(params.model);
    }
    const toolName = params.tool_name ?? params.tool;
    if (toolName) {
      observationConditions.push('fo.tool_name = ?');
      values.push(toolName);
    }
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM trace_quality_observations fo
        WHERE fo.trace_id = t.id
          AND ${observationConditions.join(' AND ')}
      )
    `);
  }

  appendScoreExistsFilter(conditions, values, params);

  if (options.applyLowCoverageExclusion && params.exclude_low_coverage) {
    conditions.push(`NOT (${lowCoverageExpr('t')})`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

export function includedTraceSelection(params: TraceQualityTraceListParams = {}): { sql: string; values: unknown[] } {
  const { where, values } = buildTraceWhere(params, { applyLowCoverageExclusion: true });
  return {
    sql: `SELECT t.id FROM trace_quality_traces t ${where}`,
    values,
  };
}

function mapTrace(row: TraceQualityTraceSqlRow): TraceQualityTrace {
  return {
    id: row.id,
    session_id: row.session_id,
    browsing_session_id: row.browsing_session_id,
    source_trace_id: row.source_trace_id,
    agent_type: row.agent_type,
    name: row.name,
    status: row.status,
    project: row.project,
    branch: row.branch,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    metadata: parseJsonRecord(row.metadata_json),
    tags: parseJsonArray(row.tags_json),
    coverage: parseJsonRecord(row.coverage_json),
    created_at: row.created_at,
    aggregate: {
      observation_count: row.observation_count ?? 0,
      error_count: row.error_count ?? 0,
      total_tokens_in: row.total_tokens_in ?? 0,
      total_tokens_out: row.total_tokens_out ?? 0,
      total_cache_read_tokens: row.total_cache_read_tokens ?? 0,
      total_cache_write_tokens: row.total_cache_write_tokens ?? 0,
      total_cost_usd: row.total_cost_usd ?? 0,
      total_duration_ms: row.total_duration_ms ?? 0,
      first_observation_at: row.first_observation_at,
      last_observation_at: row.last_observation_at,
    },
    score_count: row.score_count ?? 0,
    numeric_score_avg: row.numeric_score_avg,
  };
}

function mapObservation(row: TraceQualityObservationRow): TraceQualityObservation {
  return {
    ...row,
    metadata: parseJsonRecord(row.metadata_json),
  };
}

function scoreValue(row: TraceQualityScoreRow): TraceQualityScore['value'] {
  switch (row.value_type) {
    case 'numeric':
      return row.numeric_value;
    case 'categorical':
      return row.categorical_value;
    case 'boolean':
      return row.boolean_value == null ? null : row.boolean_value === 1;
    case 'text':
      return row.text_value;
    default:
      return null;
  }
}

function scoreSummaryCategoryKey(name: string, valueType: string): string {
  return `${name}\u0000${valueType}`;
}

function mapScore(row: TraceQualityScoreRow): TraceQualityScore {
  return {
    ...row,
    metadata: parseJsonRecord(row.metadata_json),
    value: scoreValue(row),
  };
}

function mapPromptRef(row: PromptRefSqlRow): TraceQualityPromptRef {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    label: row.label,
    source: row.source,
    content_hash: row.content_hash,
    file_path: row.file_path,
    metadata: parseJsonRecord(row.metadata_json),
    created_at: row.created_at,
    observation_count: row.observation_count,
    trace_count: row.trace_count,
  };
}

function traceAggregateSelect(alias = 't'): string {
  return `
    (SELECT COUNT(*) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS observation_count,
    (SELECT COUNT(*) FROM trace_quality_observations o
      WHERE o.trace_id = ${alias}.id
        AND (o.status IN ('error', 'timeout') OR o.severity IN ('error', 'critical'))
    ) AS error_count,
    (SELECT COALESCE(SUM(o.tokens_in), 0) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS total_tokens_in,
    (SELECT COALESCE(SUM(o.tokens_out), 0) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS total_tokens_out,
    (SELECT COALESCE(SUM(o.cache_read_tokens), 0) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS total_cache_read_tokens,
    (SELECT COALESCE(SUM(o.cache_write_tokens), 0) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS total_cache_write_tokens,
    (SELECT COALESCE(SUM(o.cost_usd), 0) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS total_cost_usd,
    (SELECT COALESCE(SUM(o.duration_ms), 0) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS total_duration_ms,
    (SELECT MIN(o.started_at) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS first_observation_at,
    (SELECT MAX(COALESCE(o.ended_at, o.started_at, o.created_at)) FROM trace_quality_observations o WHERE o.trace_id = ${alias}.id) AS last_observation_at,
    (
      SELECT COUNT(*)
      FROM (${traceScoreTargetSql()}) ss
      WHERE ss.resolved_trace_id = ${alias}.id
    ) AS score_count,
    (
      SELECT AVG(ss.numeric_value)
      FROM (${traceScoreTargetSql()}) ss
      WHERE ss.resolved_trace_id = ${alias}.id
        AND ss.numeric_value IS NOT NULL
    ) AS numeric_score_avg
  `;
}

function coverageFromTraceSelection(
  includedTraceSql: string,
  includedValues: unknown[],
  matchingTraces: number,
  includedTraces: number,
  excludedLowCoverageTraces: number,
): TraceQualityReadCoverage {
  const db = getDb();
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN ${observationHasUsageExpr('o')} THEN 1 ELSE 0 END), 0) AS with_usage,
      COALESCE(SUM(CASE WHEN NOT (${observationHasUsageExpr('o')}) THEN 1 ELSE 0 END), 0) AS missing_usage
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${includedTraceSql})
  `).get(...includedValues) as { with_usage: number | null; missing_usage: number | null };

  const scores = db.prepare(`
    SELECT
      COUNT(*) AS total_scores,
      COALESCE(SUM(CASE WHEN target_type = 'trace' THEN 1 ELSE 0 END), 0) AS trace_score_count,
      COALESCE(SUM(CASE WHEN target_type = 'observation' THEN 1 ELSE 0 END), 0) AS observation_score_count,
      COALESCE(SUM(CASE WHEN value_type = 'numeric' THEN 1 ELSE 0 END), 0) AS numeric_score_count,
      COUNT(DISTINCT resolved_trace_id) AS scored_traces
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE resolved_trace_id IN (${includedTraceSql})
  `).get(...includedValues) as {
    total_scores: number | null;
    trace_score_count: number | null;
    observation_score_count: number | null;
    numeric_score_count: number | null;
    scored_traces: number | null;
  };

  const scoreCoverage: TraceQualityScoreCoverage = {
    scored_traces: scores.scored_traces ?? 0,
    unscored_traces: Math.max(includedTraces - (scores.scored_traces ?? 0), 0),
    total_scores: scores.total_scores ?? 0,
    trace_score_count: scores.trace_score_count ?? 0,
    observation_score_count: scores.observation_score_count ?? 0,
    numeric_score_count: scores.numeric_score_count ?? 0,
  };

  return {
    matching_traces: matchingTraces,
    included_traces: includedTraces,
    excluded_low_coverage_traces: excludedLowCoverageTraces,
    observations_with_usage: usage.with_usage ?? 0,
    observations_missing_usage: usage.missing_usage ?? 0,
    score_coverage: scoreCoverage,
    note: 'Trace-quality coverage describes projected local rows and highlights partial source fidelity.',
  };
}

export function getTraceQualityCoverage(params: TraceQualityTraceListParams = {}): TraceQualityReadCoverage {
  const db = getDb();
  const matching = buildTraceWhere(params, { applyLowCoverageExclusion: false });
  const included = buildTraceWhere(params, { applyLowCoverageExclusion: true });
  const matchingTraces = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM trace_quality_traces t
    ${matching.where}
  `).get(...matching.values) as CountResult).c;

  const includedTraces = params.exclude_low_coverage
    ? (db.prepare(`
        SELECT COUNT(*) AS c
        FROM trace_quality_traces t
        ${included.where}
      `).get(...included.values) as CountResult).c
    : matchingTraces;

  const selection = includedTraceSelection(params);
  return coverageFromTraceSelection(
    selection.sql,
    selection.values,
    matchingTraces,
    includedTraces,
    params.exclude_low_coverage ? Math.max(matchingTraces - includedTraces, 0) : 0,
  );
}

function coverageForTraceId(traceId: string): TraceQualityReadCoverage {
  return coverageFromTraceSelection(
    'SELECT ? AS id',
    [traceId],
    1,
    1,
    0,
  );
}

export function listTraceQualityTraces(params: TraceQualityTraceListParams = {}): {
  data: TraceQualityTrace[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
} {
  const db = getDb();
  const limit = normalizedLimit(params.limit, 50, 500);
  const offset = normalizedOffset(params.offset);
  const included = buildTraceWhere(params, { applyLowCoverageExclusion: true });
  const total = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM trace_quality_traces t
    ${included.where}
  `).get(...included.values) as CountResult).c;

  const rows = db.prepare(`
    SELECT
      t.*,
      ${traceAggregateSelect('t')}
    FROM trace_quality_traces t
    ${included.where}
    ORDER BY datetime(COALESCE(t.started_at, t.created_at)) DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(...included.values, limit, offset) as TraceQualityTraceSqlRow[];

  return {
    data: rows.map(mapTrace),
    total,
    limit,
    offset,
    coverage: getTraceQualityCoverage(params),
  };
}

function getPromptRefsForTrace(traceId: string): TraceQualityPromptRef[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      pr.*,
      COUNT(DISTINCT op.observation_id) AS observation_count,
      COUNT(DISTINCT o.trace_id) AS trace_count
    FROM trace_quality_prompt_refs pr
    JOIN trace_quality_observation_prompts op ON op.prompt_ref_id = pr.id
    JOIN trace_quality_observations o ON o.id = op.observation_id
    WHERE o.trace_id = ?
    GROUP BY pr.id
    ORDER BY pr.name, pr.version, pr.id
  `).all(traceId) as PromptRefSqlRow[];
  return rows.map(mapPromptRef);
}

function getPromptRefsForObservation(observationId: string): TraceQualityPromptRef[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      pr.*,
      COUNT(DISTINCT op.observation_id) AS observation_count,
      COUNT(DISTINCT o.trace_id) AS trace_count
    FROM trace_quality_prompt_refs pr
    JOIN trace_quality_observation_prompts op ON op.prompt_ref_id = pr.id
    JOIN trace_quality_observations o ON o.id = op.observation_id
    WHERE o.id = ?
    GROUP BY pr.id
    ORDER BY pr.name, pr.version, pr.id
  `).all(observationId) as PromptRefSqlRow[];
  return rows.map(mapPromptRef);
}

export function getTraceQualityScoreSummary(params: TraceQualityTraceListParams = {}): {
  data: TraceQualityScoreSummary[];
  coverage: TraceQualityReadCoverage;
} {
  const db = getDb();
  const selection = includedTraceSelection(params);
  const rows = db.prepare(`
    SELECT
      name,
      value_type,
      COUNT(*) AS count,
      AVG(numeric_value) AS numeric_avg,
      MIN(numeric_value) AS numeric_min,
      MAX(numeric_value) AS numeric_max,
      COALESCE(SUM(CASE WHEN boolean_value = 1 THEN 1 ELSE 0 END), 0) AS boolean_true,
      COALESCE(SUM(CASE WHEN boolean_value = 0 THEN 1 ELSE 0 END), 0) AS boolean_false,
      COUNT(DISTINCT resolved_trace_id) AS scored_traces
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE resolved_trace_id IN (${selection.sql})
    GROUP BY name, value_type
    ORDER BY name, value_type
  `).all(...selection.values) as ScoreSummarySqlRow[];

  const categoryRows = db.prepare(`
    SELECT name, value_type, categorical_value, COUNT(*) AS c
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE resolved_trace_id IN (${selection.sql})
      AND categorical_value IS NOT NULL
    GROUP BY name, value_type, categorical_value
    ORDER BY name, value_type, categorical_value
  `).all(...selection.values) as CategoryCountSqlRow[];
  const categoryCounts = new Map<string, Record<string, number>>();
  for (const row of categoryRows) {
    const key = scoreSummaryCategoryKey(row.name, row.value_type);
    const counts = categoryCounts.get(key) ?? {};
    counts[row.categorical_value] = row.c;
    categoryCounts.set(key, counts);
  }

  return {
    data: rows.map(row => ({
      name: row.name,
      value_type: row.value_type,
      count: row.count,
      numeric_avg: row.numeric_avg,
      numeric_min: row.numeric_min,
      numeric_max: row.numeric_max,
      boolean_true: row.boolean_true ?? 0,
      boolean_false: row.boolean_false ?? 0,
      categorical_values: categoryCounts.get(scoreSummaryCategoryKey(row.name, row.value_type)) ?? {},
      scored_traces: row.scored_traces,
    })),
    coverage: getTraceQualityCoverage(params),
  };
}

function buildScoreValueFilter(alias: string, params: TraceQualityTraceListParams): { sql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.score_name) {
    conditions.push(`${alias}.name = ?`);
    values.push(params.score_name);
  }
  if (params.min_score != null) {
    conditions.push(`${alias}.numeric_value >= ?`);
    values.push(params.min_score);
  }
  if (params.max_score != null) {
    conditions.push(`${alias}.numeric_value <= ?`);
    values.push(params.max_score);
  }
  return {
    sql: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '',
    values,
  };
}

function scoreRollupBaseCte(params: TraceQualityTraceListParams, includeSessionScopedScores: boolean): { sql: string; values: unknown[] } {
  const selection = includedTraceSelection(params);
  const traceScoreFilter = buildScoreValueFilter('s', params);
  const sessionScopedScoreFilter = buildScoreValueFilter('ss', params);
  const sessionScopedScoreUnion = includeSessionScopedScores
    ? `
      UNION ALL
      SELECT
        ss.id,
        ss.name,
        ss.value_type,
        ss.numeric_value,
        ss.categorical_value,
        ss.boolean_value,
        ss.created_at,
        ro.trace_id,
        rt.name AS trace_name,
        CASE
          WHEN ss.target_type = 'session' THEN ss.target_id
          WHEN ss.target_type = 'event' THEN se.session_id
          WHEN ss.target_type = 'message' THEN sm.session_id
          WHEN ss.target_type = 'session_item' THEN si.session_id
          ELSE NULL
        END AS session_id,
        ro.id AS observation_id,
        COALESCE(ro.model, se.model) AS model,
        COALESCE(ro.tool_name, se.tool_name) AS tool_name
      FROM trace_quality_scores ss
      LEFT JOIN events se
        ON ss.target_type = 'event'
       AND (ss.target_id = CAST(se.id AS TEXT) OR ss.target_id = se.event_id)
      LEFT JOIN messages sm
        ON ss.target_type = 'message'
       AND ss.target_id = CAST(sm.id AS TEXT)
      LEFT JOIN session_items si
        ON ss.target_type = 'session_item'
       AND (ss.target_id = CAST(si.id AS TEXT) OR ss.target_id = si.source_item_id)
      LEFT JOIN trace_quality_observations ro
        ON (ss.target_type = 'event'
            AND ro.source_kind = 'event'
            AND (ro.source_id = CAST(se.id AS TEXT) OR ro.source_item_id = se.event_id))
        OR (ss.target_type = 'message'
            AND ro.source_kind = 'message'
            AND ro.source_id = CAST(sm.id AS TEXT))
        OR (ss.target_type = 'session_item'
            AND ro.source_kind = 'session_item'
            AND (ro.source_id = CAST(si.id AS TEXT) OR ro.source_item_id = si.source_item_id))
      LEFT JOIN trace_quality_traces rt ON rt.id = ro.trace_id
      WHERE (
          (
            ss.target_type = 'session'
            AND ss.target_id IN (SELECT session_id FROM selected_sessions)
          )
          OR (
            ss.target_type = 'event'
            AND se.session_id IN (SELECT session_id FROM selected_sessions)
          )
          OR (
            ss.target_type = 'message'
            AND sm.session_id IN (SELECT session_id FROM selected_sessions)
          )
          OR (
            ss.target_type = 'session_item'
            AND si.session_id IN (SELECT session_id FROM selected_sessions)
          )
        )
        ${sessionScopedScoreFilter.sql}
    `
    : '';

  return {
    sql: `
      WITH selected_traces AS (${selection.sql}),
      selected_sessions AS (
        SELECT DISTINCT session_id
        FROM trace_quality_traces
        WHERE id IN (SELECT id FROM selected_traces)
      ),
      score_base AS (
        SELECT
          s.id,
          s.name,
          s.value_type,
          s.numeric_value,
          s.categorical_value,
          s.boolean_value,
          s.created_at,
          t.id AS trace_id,
          t.name AS trace_name,
          t.session_id,
          o.id AS observation_id,
          o.model,
          o.tool_name
        FROM trace_quality_scores s
        LEFT JOIN trace_quality_observations o
          ON s.target_type = 'observation'
         AND s.target_id = o.id
        JOIN trace_quality_traces t
          ON (s.target_type = 'trace' AND s.target_id = t.id)
          OR (s.target_type = 'observation' AND o.trace_id = t.id)
        WHERE t.id IN (SELECT id FROM selected_traces)
          ${traceScoreFilter.sql}
        ${sessionScopedScoreUnion}
      )
    `,
    values: [
      ...selection.values,
      ...traceScoreFilter.values,
      ...(includeSessionScopedScores ? sessionScopedScoreFilter.values : []),
    ],
  };
}

function scoreRollupAggregateSelect(
  dimension: TraceQualityScoreRollupDimension,
  keyExpression: string,
  labelExpression: string,
  baseAlias = '',
): string {
  const prefix = baseAlias ? `${baseAlias}.` : '';
  return `
    SELECT
      '${dimension}' AS dimension,
      ${keyExpression} AS key,
      ${labelExpression} AS label,
      COUNT(*) AS score_count,
      COALESCE(SUM(CASE WHEN ${prefix}numeric_value IS NOT NULL THEN 1 ELSE 0 END), 0) AS numeric_score_count,
      AVG(${prefix}numeric_value) AS numeric_avg,
      COALESCE(SUM(CASE WHEN ${prefix}boolean_value = 1 THEN 1 ELSE 0 END), 0) AS boolean_true,
      COALESCE(SUM(CASE WHEN ${prefix}boolean_value = 0 THEN 1 ELSE 0 END), 0) AS boolean_false,
      COUNT(DISTINCT ${prefix}trace_id) AS trace_count,
      COUNT(DISTINCT ${prefix}observation_id) AS observation_count,
      MIN(${prefix}created_at) AS first_score_at,
      MAX(${prefix}created_at) AS last_score_at
  `;
}

function mapScoreRollups(
  dimension: TraceQualityScoreRollupDimension,
  rows: ScoreRollupSqlRow[],
  categoryRows: ScoreRollupCategorySqlRow[],
): TraceQualityScoreRollup[] {
  const categoryCounts = new Map<string, Record<string, number>>();
  for (const row of categoryRows) {
    const counts = categoryCounts.get(row.key) ?? {};
    counts[row.categorical_value] = row.c;
    categoryCounts.set(row.key, counts);
  }

  return rows.map(row => ({
    dimension,
    key: row.key,
    label: row.label,
    score_count: row.score_count,
    numeric_score_count: row.numeric_score_count ?? 0,
    numeric_avg: row.numeric_avg,
    boolean_true: row.boolean_true ?? 0,
    boolean_false: row.boolean_false ?? 0,
    categorical_values: categoryCounts.get(row.key) ?? {},
    trace_count: row.trace_count,
    observation_count: row.observation_count,
    first_score_at: row.first_score_at,
    last_score_at: row.last_score_at,
  }));
}

function getSimpleScoreRollups(
  dimension: Exclude<TraceQualityScoreRollupDimension, 'prompt'>,
  params: TraceQualityTraceListParams,
  keyExpression: string,
  labelExpression: string,
  whereExpression: string,
  includeSessionScores: boolean,
): TraceQualityScoreRollup[] {
  const db = getDb();
  const base = scoreRollupBaseCte(params, includeSessionScores);
  const rows = db.prepare(`
    ${base.sql}
    ${scoreRollupAggregateSelect(dimension, keyExpression, labelExpression)}
    FROM score_base
    WHERE ${whereExpression}
    GROUP BY key
    ORDER BY score_count DESC, key
    LIMIT 100
  `).all(...base.values) as ScoreRollupSqlRow[];

  const categoryRows = db.prepare(`
    ${base.sql}
    SELECT
      ${keyExpression} AS key,
      categorical_value,
      COUNT(*) AS c
    FROM score_base
    WHERE ${whereExpression}
      AND categorical_value IS NOT NULL
    GROUP BY key, categorical_value
    ORDER BY key, categorical_value
  `).all(...base.values) as ScoreRollupCategorySqlRow[];

  return mapScoreRollups(dimension, rows, categoryRows);
}

function getPromptScoreRollups(params: TraceQualityTraceListParams): TraceQualityScoreRollup[] {
  const db = getDb();
  const base = scoreRollupBaseCte(params, true);
  const rows = db.prepare(`
    ${base.sql}
    ${scoreRollupAggregateSelect('prompt', "CAST(pr.id AS TEXT)", "pr.name || COALESCE('@' || pr.version, '')", 'score_base')}
    FROM score_base
    JOIN trace_quality_observation_prompts op ON op.observation_id = score_base.observation_id
    JOIN trace_quality_prompt_refs pr ON pr.id = op.prompt_ref_id
    GROUP BY pr.id
    ORDER BY score_count DESC, pr.name, pr.version, pr.id
    LIMIT 100
  `).all(...base.values) as ScoreRollupSqlRow[];

  const categoryRows = db.prepare(`
    ${base.sql}
    SELECT
      CAST(pr.id AS TEXT) AS key,
      score_base.categorical_value,
      COUNT(*) AS c
    FROM score_base
    JOIN trace_quality_observation_prompts op ON op.observation_id = score_base.observation_id
    JOIN trace_quality_prompt_refs pr ON pr.id = op.prompt_ref_id
    WHERE score_base.categorical_value IS NOT NULL
    GROUP BY pr.id, score_base.categorical_value
    ORDER BY pr.id, score_base.categorical_value
  `).all(...base.values) as ScoreRollupCategorySqlRow[];

  return mapScoreRollups('prompt', rows, categoryRows);
}

export function getTraceQualityScoreRollups(params: TraceQualityTraceListParams = {}): {
  data: TraceQualityScoreRollups;
  coverage: TraceQualityReadCoverage;
} {
  return {
    data: {
      trace: getSimpleScoreRollups('trace', params, 'trace_id', 'MAX(trace_name)', 'trace_id IS NOT NULL', true),
      session: getSimpleScoreRollups('session', params, 'session_id', 'session_id', 'session_id IS NOT NULL', true),
      model: getSimpleScoreRollups('model', params, 'model', 'model', 'model IS NOT NULL', true),
      tool: getSimpleScoreRollups('tool', params, 'tool_name', 'tool_name', 'tool_name IS NOT NULL', true),
      prompt: getPromptScoreRollups(params),
      day: getSimpleScoreRollups('day', params, "substr(created_at, 1, 10)", "substr(created_at, 1, 10)", 'created_at IS NOT NULL', true),
    },
    coverage: getTraceQualityCoverage(params),
  };
}

function getScoreSummaryForTrace(traceId: string): TraceQualityScoreSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      name,
      value_type,
      COUNT(*) AS count,
      AVG(numeric_value) AS numeric_avg,
      MIN(numeric_value) AS numeric_min,
      MAX(numeric_value) AS numeric_max,
      COALESCE(SUM(CASE WHEN boolean_value = 1 THEN 1 ELSE 0 END), 0) AS boolean_true,
      COALESCE(SUM(CASE WHEN boolean_value = 0 THEN 1 ELSE 0 END), 0) AS boolean_false,
      COUNT(DISTINCT resolved_trace_id) AS scored_traces
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE resolved_trace_id = ?
    GROUP BY name, value_type
    ORDER BY name, value_type
  `).all(traceId) as ScoreSummarySqlRow[];

  const categoryRows = db.prepare(`
    SELECT name, value_type, categorical_value, COUNT(*) AS c
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE resolved_trace_id = ?
      AND categorical_value IS NOT NULL
    GROUP BY name, value_type, categorical_value
    ORDER BY name, value_type, categorical_value
  `).all(traceId) as CategoryCountSqlRow[];
  const categoryCounts = new Map<string, Record<string, number>>();
  for (const row of categoryRows) {
    const key = scoreSummaryCategoryKey(row.name, row.value_type);
    const counts = categoryCounts.get(key) ?? {};
    counts[row.categorical_value] = row.c;
    categoryCounts.set(key, counts);
  }

  return rows.map(row => ({
    name: row.name,
    value_type: row.value_type,
    count: row.count,
    numeric_avg: row.numeric_avg,
    numeric_min: row.numeric_min,
    numeric_max: row.numeric_max,
    boolean_true: row.boolean_true ?? 0,
    boolean_false: row.boolean_false ?? 0,
    categorical_values: categoryCounts.get(scoreSummaryCategoryKey(row.name, row.value_type)) ?? {},
    scored_traces: row.scored_traces,
  }));
}

export function getTraceQualityTrace(id: string): { trace: TraceQualityTraceDetail; coverage: TraceQualityReadCoverage } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      t.*,
      ${traceAggregateSelect('t')}
    FROM trace_quality_traces t
    WHERE t.id = ?
  `).get(id) as TraceQualityTraceSqlRow | undefined;
  if (!row) return null;

  return {
    trace: {
      ...mapTrace(row),
      prompt_refs: getPromptRefsForTrace(id),
      score_summary: getScoreSummaryForTrace(id),
    },
    coverage: coverageForTraceId(id),
  };
}

function buildObservationTree(observations: TraceQualityObservation[]): TraceQualityObservationTreeNode[] {
  const nodes = new Map<string, TraceQualityObservationTreeNode>();
  const roots: TraceQualityObservationTreeNode[] = [];
  for (const observation of observations) {
    nodes.set(observation.id, { ...observation, children: [] });
  }
  for (const observation of observations) {
    const node = nodes.get(observation.id);
    if (!node) continue;
    const parent = observation.parent_observation_id ? nodes.get(observation.parent_observation_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function listTraceQualityObservations(
  traceId: string,
  params: TraceQualityObservationListParams = {},
): {
  data: TraceQualityObservation[];
  tree: TraceQualityObservationTreeNode[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
} | null {
  const db = getDb();
  const trace = db.prepare('SELECT id FROM trace_quality_traces WHERE id = ?').get(traceId) as { id: string } | undefined;
  if (!trace) return null;

  const limit = normalizedLimit(params.limit, 500, 1000);
  const offset = normalizedOffset(params.offset);
  const total = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM trace_quality_observations
    WHERE trace_id = ?
  `).get(traceId) as CountResult).c;
  const rows = db.prepare(`
    SELECT *
    FROM trace_quality_observations
    WHERE trace_id = ?
    ORDER BY datetime(COALESCE(started_at, created_at)), id
    LIMIT ? OFFSET ?
  `).all(traceId, limit, offset) as TraceQualityObservationRow[];
  const data = rows.map(mapObservation);
  return {
    data,
    tree: buildObservationTree(data),
    total,
    limit,
    offset,
    coverage: coverageForTraceId(traceId),
  };
}

export function getTraceQualityObservation(id: string): {
  observation: TraceQualityObservationDetail;
  coverage: TraceQualityReadCoverage;
} | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM trace_quality_observations WHERE id = ?')
    .get(id) as TraceQualityObservationRow | undefined;
  if (!row) return null;

  const trace = db.prepare(`
    SELECT id, session_id, agent_type, name, status, project, started_at
    FROM trace_quality_traces
    WHERE id = ?
  `).get(row.trace_id) as TraceQualityObservationDetail['trace'] | undefined;
  if (!trace) return null;

  const scores = db.prepare(`
    SELECT *
    FROM trace_quality_scores
    WHERE target_type = 'observation'
      AND target_id = ?
    ORDER BY name, created_at DESC, id
  `).all(id) as TraceQualityScoreRow[];

  return {
    observation: {
      ...mapObservation(row),
      trace,
      prompt_refs: getPromptRefsForObservation(id),
      scores: scores.map(mapScore),
    },
    coverage: coverageForTraceId(row.trace_id),
  };
}

function hasScoreTraceFilter(params: TraceQualityScoreListParams): boolean {
  return Boolean(
    params.project
    || params.agent
    || params.status
    || params.observation_type
    || params.model
    || params.tool
    || params.tool_name
    || params.exclude_low_coverage,
  );
}

function buildScoreWhere(params: TraceQualityScoreListParams): { where: string; values: unknown[] } {
  const conditions = ['1 = 1'];
  const values: unknown[] = [];

  if (params.trace_id) {
    conditions.push(`
      (
        resolved_trace_id = ?
        OR resolved_session_id = (
          SELECT session_id
          FROM trace_quality_traces
          WHERE id = ?
        )
      )
    `);
    values.push(params.trace_id, params.trace_id);
  }
  if (params.observation_id) {
    conditions.push("target_type = 'observation' AND target_id = ?");
    values.push(params.observation_id);
  }
  if (params.target_type) {
    conditions.push('target_type = ?');
    values.push(params.target_type);
  }
  if (params.target_id) {
    conditions.push('target_id = ?');
    values.push(params.target_id);
  }
  if (params.name) {
    conditions.push('name = ?');
    values.push(params.name);
  }
  if (params.source) {
    conditions.push('source = ?');
    values.push(params.source);
  }
  appendDateRangeConditions(conditions, values, 'created_at', params.date_from, params.date_to);
  if (params.min_score != null) {
    conditions.push('numeric_value >= ?');
    values.push(params.min_score);
  }
  if (params.max_score != null) {
    conditions.push('numeric_value <= ?');
    values.push(params.max_score);
  }

  const traceFilters: TraceQualityTraceListParams = {
    project: params.project,
    agent: params.agent,
    status: params.status,
    observation_type: params.observation_type,
    model: params.model,
    tool: params.tool,
    tool_name: params.tool_name,
    exclude_low_coverage: params.exclude_low_coverage,
  };
  if (hasScoreTraceFilter(params)) {
    const selection = includedTraceSelection(traceFilters);
    conditions.push(`
      (
        resolved_trace_id IN (${selection.sql})
        OR resolved_session_id IN (
          SELECT session_id
          FROM trace_quality_traces
          WHERE id IN (${selection.sql})
        )
      )
    `);
    values.push(...selection.values, ...selection.values);
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, values };
}

export function listTraceQualityScores(params: TraceQualityScoreListParams = {}): {
  data: TraceQualityScore[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
} {
  const db = getDb();
  const limit = normalizedLimit(params.limit, 100, 500);
  const offset = normalizedOffset(params.offset);
  const { where, values } = buildScoreWhere(params);

  const total = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM (${traceScoreTargetSql()}) score_targets
    ${where}
  `).get(...values) as CountResult).c;
  const rows = db.prepare(`
    SELECT *
    FROM (${traceScoreTargetSql()}) score_targets
    ${where}
    ORDER BY name, created_at, id
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as TraceQualityScoreRow[];

  return {
    data: rows.map(mapScore),
    total,
    limit,
    offset,
    coverage: getTraceQualityCoverage({
      project: params.project,
      agent: params.agent,
      status: params.status,
      observation_type: params.observation_type,
      model: params.model,
      tool: params.tool,
      tool_name: params.tool_name,
      exclude_low_coverage: params.exclude_low_coverage,
    }),
  };
}

export function listTraceQualityPrompts(params: TraceQualityTraceListParams = {}): {
  data: TraceQualityPromptRollup[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
} {
  const db = getDb();
  const limit = normalizedLimit(params.limit, 100, 500);
  const offset = normalizedOffset(params.offset);
  const selection = includedTraceSelection(params);
  const total = (db.prepare(`
    SELECT COUNT(DISTINCT pr.id) AS c
    FROM trace_quality_prompt_refs pr
    JOIN trace_quality_observation_prompts op ON op.prompt_ref_id = pr.id
    JOIN trace_quality_observations o ON o.id = op.observation_id
    WHERE o.trace_id IN (${selection.sql})
  `).get(...selection.values) as CountResult).c;

  const rows = db.prepare(`
    SELECT
      pr.*,
      COUNT(DISTINCT op.observation_id) AS observation_count,
      COUNT(DISTINCT o.trace_id) AS trace_count,
      COUNT(DISTINCT CASE WHEN o.observation_type = 'generation' THEN o.id END) AS generation_count,
      COALESCE(SUM(COALESCE(o.cost_usd, 0)), 0) AS total_cost_usd,
      COALESCE(SUM(COALESCE(o.tokens_in, 0)), 0) AS total_tokens_in,
      COALESCE(SUM(COALESCE(o.tokens_out, 0)), 0) AS total_tokens_out,
      GROUP_CONCAT(CASE WHEN o.duration_ms IS NOT NULL THEN o.duration_ms END) AS duration_values,
      MAX(COALESCE(o.started_at, o.created_at)) AS latest_observation_at
    FROM trace_quality_prompt_refs pr
    JOIN trace_quality_observation_prompts op ON op.prompt_ref_id = pr.id
    JOIN trace_quality_observations o ON o.id = op.observation_id
    WHERE o.trace_id IN (${selection.sql})
    GROUP BY pr.id
    ORDER BY pr.name, pr.version, pr.id
    LIMIT ? OFFSET ?
  `).all(...selection.values, limit, offset) as PromptRollupSqlRow[];

  const promptIds = rows.map(row => row.id);
  const scoreMetrics = new Map<number, { scoreCount: number; medianNumericScore: number | null }>();
  if (promptIds.length > 0) {
    const base = scoreRollupBaseCte(params, true);
    // Two disjoint branches (split on observation_id IS NULL) keep both joins as
    // index-friendly equi-joins. Observation-scoped scores attach to prompts on that
    // exact observation; trace-scoped scores attach to every prompt on any observation
    // in the trace. Session-scoped scores (no trace_id) are intentionally excluded.
    const scoreRows = db.prepare(`
      ${base.sql}
      SELECT DISTINCT prompt_ref_id, score_id, numeric_value
      FROM (
        SELECT
          op.prompt_ref_id AS prompt_ref_id,
          score_base.id AS score_id,
          score_base.numeric_value AS numeric_value
        FROM score_base
        JOIN trace_quality_observation_prompts op
          ON op.observation_id = score_base.observation_id
        WHERE score_base.observation_id IS NOT NULL
          AND op.prompt_ref_id IN (${placeholders(promptIds)})

        UNION ALL

        SELECT
          op.prompt_ref_id AS prompt_ref_id,
          score_base.id AS score_id,
          score_base.numeric_value AS numeric_value
        FROM score_base
        JOIN trace_quality_observations o
          ON o.trace_id = score_base.trace_id
        JOIN trace_quality_observation_prompts op
          ON op.observation_id = o.id
        WHERE score_base.observation_id IS NULL
          AND score_base.trace_id IS NOT NULL
          AND op.prompt_ref_id IN (${placeholders(promptIds)})
      ) prompt_scores
      ORDER BY prompt_ref_id, score_id
    `).all(...base.values, ...promptIds, ...promptIds) as PromptScoreMetricSqlRow[];

    const scoreIdsByPrompt = new Map<number, Set<number>>();
    const numericScoresByPrompt = new Map<number, number[]>();
    for (const row of scoreRows) {
      const scoreIds = scoreIdsByPrompt.get(row.prompt_ref_id) ?? new Set<number>();
      scoreIds.add(row.score_id);
      scoreIdsByPrompt.set(row.prompt_ref_id, scoreIds);
      if (row.numeric_value != null) {
        const values = numericScoresByPrompt.get(row.prompt_ref_id) ?? [];
        values.push(row.numeric_value);
        numericScoresByPrompt.set(row.prompt_ref_id, values);
      }
    }

    for (const promptId of promptIds) {
      scoreMetrics.set(promptId, {
        scoreCount: scoreIdsByPrompt.get(promptId)?.size ?? 0,
        medianNumericScore: median(numericScoresByPrompt.get(promptId) ?? []),
      });
    }
  }

  return {
    data: rows.map(row => ({
      ...mapPromptRef(row),
      generation_count: row.generation_count ?? 0,
      median_duration_ms: median(parseNumberList(row.duration_values)),
      total_cost_usd: row.total_cost_usd ?? 0,
      total_tokens_in: row.total_tokens_in ?? 0,
      total_tokens_out: row.total_tokens_out ?? 0,
      score_count: scoreMetrics.get(row.id)?.scoreCount ?? 0,
      median_numeric_score: scoreMetrics.get(row.id)?.medianNumericScore ?? null,
      last_seen: row.latest_observation_at ?? null,
    })),
    total,
    limit,
    offset,
    coverage: getTraceQualityCoverage(params),
  };
}

// Trace-quality findings now live in ./findings.ts (see the unified taxonomy).
// Shared read helpers above (includedTraceSelection, lowCoverageExpr, traceScoreTargetSql,
// getTraceQualityCoverage, parseJsonRecord, median, percentile inputs, normalizers) are exported
// for that module to reuse without duplicating SQL.
