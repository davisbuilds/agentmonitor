import { getDb } from '../db/connection.js';
import type {
  CountResult,
  TraceQualityFinding,
  TraceQualityObservation,
  TraceQualityObservationDetail,
  TraceQualityObservationListParams,
  TraceQualityObservationTreeNode,
  TraceQualityPromptRef,
  TraceQualityPromptRollup,
  TraceQualityReadCoverage,
  TraceQualityScore,
  TraceQualityScoreCoverage,
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

interface FindingSortFields {
  sort_at: string;
  sort_rank: number;
}

type TraceQualityFindingWithSort = TraceQualityFinding & FindingSortFields;

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
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

function normalizedLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function normalizedOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}

function addDaysToDateString(date: string, days: number): string | null {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function lowCoverageExpr(alias = 't'): string {
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

function traceScoreTargetSql(): string {
  return `
    SELECT
      s.*,
      CASE
        WHEN s.target_type = 'trace' THEN s.target_id
        WHEN s.target_type = 'observation' THEN so.trace_id
        ELSE NULL
      END AS resolved_trace_id,
      CASE
        WHEN s.target_type = 'observation' THEN s.target_id
        ELSE NULL
      END AS resolved_observation_id
    FROM trace_quality_scores s
    LEFT JOIN trace_quality_observations so
      ON s.target_type = 'observation'
     AND s.target_id = so.id
  `;
}

function appendDateRangeConditions(
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
      WHERE (
          (fs.target_type = 'trace' AND fs.target_id = t.id)
          OR (fs.target_type = 'observation' AND fso.trace_id = t.id)
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

function includedTraceSelection(params: TraceQualityTraceListParams = {}): { sql: string; values: unknown[] } {
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

function getTraceQualityCoverage(params: TraceQualityTraceListParams = {}): TraceQualityReadCoverage {
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

function buildScoreWhere(params: TraceQualityScoreListParams): { where: string; values: unknown[] } {
  const conditions = ['resolved_trace_id IS NOT NULL'];
  const values: unknown[] = [];

  if (params.trace_id) {
    conditions.push('resolved_trace_id = ?');
    values.push(params.trace_id);
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
  const selection = includedTraceSelection(traceFilters);
  conditions.push(`resolved_trace_id IN (${selection.sql})`);
  values.push(...selection.values);

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
      MAX(COALESCE(o.started_at, o.created_at)) AS latest_observation_at
    FROM trace_quality_prompt_refs pr
    JOIN trace_quality_observation_prompts op ON op.prompt_ref_id = pr.id
    JOIN trace_quality_observations o ON o.id = op.observation_id
    WHERE o.trace_id IN (${selection.sql})
    GROUP BY pr.id
    ORDER BY pr.name, pr.version, pr.id
    LIMIT ? OFFSET ?
  `).all(...selection.values, limit, offset) as PromptRefSqlRow[];

  return {
    data: rows.map(row => ({
      ...mapPromptRef(row),
      latest_observation_at: row.latest_observation_at ?? null,
    })),
    total,
    limit,
    offset,
    coverage: getTraceQualityCoverage(params),
  };
}

function findingSeverityRank(severity: TraceQualityFinding['severity']): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'error':
      return 1;
    case 'warning':
      return 2;
    default:
      return 3;
  }
}

function mapLowScoreSeverity(value: number): TraceQualityFinding['severity'] {
  if (value <= 0.2) return 'critical';
  if (value <= 0.35) return 'warning';
  return 'warning';
}

export function listTraceQualityFindings(params: TraceQualityTraceListParams = {}): {
  data: TraceQualityFinding[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
} {
  const db = getDb();
  const limit = normalizedLimit(params.limit, 100, 500);
  const offset = normalizedOffset(params.offset);
  const selection = includedTraceSelection(params);
  const findings: TraceQualityFindingWithSort[] = [];

  const observationRows = db.prepare(`
    SELECT
      o.id AS observation_id,
      o.trace_id,
      o.name,
      o.status,
      o.severity,
      COALESCE(o.started_at, o.created_at) AS sort_at
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${selection.sql})
      AND (o.status IN ('error', 'timeout') OR o.severity IN ('error', 'critical'))
    ORDER BY datetime(COALESCE(o.started_at, o.created_at)), o.id
  `).all(...selection.values) as Array<{
    observation_id: string;
    trace_id: string;
    name: string;
    status: string | null;
    severity: string | null;
    sort_at: string;
  }>;

  for (const row of observationRows) {
    const severity = row.severity === 'critical' ? 'critical' : 'error';
    findings.push({
      id: `observation-error:${row.observation_id}`,
      kind: 'observation_error',
      severity,
      trace_id: row.trace_id,
      observation_id: row.observation_id,
      score_id: null,
      title: `${row.name} reported ${row.status ?? row.severity ?? 'an error'}`,
      message: 'An observation has an error or critical status and should be reviewed.',
      evidence: {
        status: row.status,
        severity: row.severity,
      },
      created_at: row.sort_at,
      sort_at: row.sort_at,
      sort_rank: 0,
    });
  }

  const lowScoreThreshold = params.max_score ?? 0.5;
  const lowScoreRows = db.prepare(`
    SELECT
      score_targets.id,
      score_targets.name,
      score_targets.numeric_value,
      score_targets.resolved_trace_id AS trace_id,
      score_targets.resolved_observation_id AS observation_id,
      score_targets.created_at
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE score_targets.resolved_trace_id IN (${selection.sql})
      AND score_targets.numeric_value IS NOT NULL
      AND score_targets.numeric_value <= ?
    ORDER BY score_targets.numeric_value, score_targets.created_at, score_targets.id
  `).all(...selection.values, lowScoreThreshold) as Array<{
    id: number;
    name: string;
    numeric_value: number;
    trace_id: string;
    observation_id: string | null;
    created_at: string;
  }>;

  for (const row of lowScoreRows) {
    findings.push({
      id: `low-score:${row.id}`,
      kind: 'low_score',
      severity: mapLowScoreSeverity(row.numeric_value),
      trace_id: row.trace_id,
      observation_id: row.observation_id,
      score_id: row.id,
      title: `${row.name} score is low`,
      message: `Numeric score ${row.numeric_value} is at or below ${lowScoreThreshold}.`,
      evidence: {
        score_name: row.name,
        numeric_value: row.numeric_value,
        threshold: lowScoreThreshold,
      },
      created_at: row.created_at,
      sort_at: row.created_at,
      sort_rank: 1,
    });
  }

  const lowCoverageRows = db.prepare(`
    SELECT id, coverage_json, COALESCE(started_at, created_at) AS sort_at
    FROM trace_quality_traces t
    WHERE t.id IN (${selection.sql})
      AND ${lowCoverageExpr('t')}
    ORDER BY datetime(COALESCE(t.started_at, t.created_at)), t.id
  `).all(...selection.values) as Array<{ id: string; coverage_json: string; sort_at: string }>;

  for (const row of lowCoverageRows) {
    findings.push({
      id: `low-coverage:${row.id}`,
      kind: 'low_coverage',
      severity: 'warning',
      trace_id: row.id,
      observation_id: null,
      score_id: null,
      title: 'Trace has low projection coverage',
      message: 'The trace was projected from partial source data.',
      evidence: parseJsonRecord(row.coverage_json),
      created_at: row.sort_at,
      sort_at: row.sort_at,
      sort_rank: 2,
    });
  }

  findings.sort((a, b) =>
    findingSeverityRank(a.severity) - findingSeverityRank(b.severity)
    || a.sort_rank - b.sort_rank
    || a.sort_at.localeCompare(b.sort_at)
    || a.id.localeCompare(b.id)
  );

  return {
    data: findings.slice(offset, offset + limit).map(({ sort_at: _sortAt, sort_rank: _sortRank, ...finding }) => finding),
    total: findings.length,
    limit,
    offset,
    coverage: getTraceQualityCoverage(params),
  };
}
