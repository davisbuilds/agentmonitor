import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { getUsageBudgets } from '../usage/budgets.js';
import type { UsageBudgetAlertState } from '../api/v2/types.js';
import type { TraceQualityFindingThresholds } from './constants.js';
import type {
  TraceQualityFinding,
  TraceQualityFindingInspection,
  TraceQualityFindingWindow,
  TraceQualityReadCoverage,
  TraceQualityTraceListParams,
} from '../api/v2/types.js';
import type { TraceQualityFindingKind, TraceQualityFindingSeverity } from './types.js';
import {
  DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS,
  TRACE_QUALITY_FINDING_KINDS,
  TRACE_QUALITY_FINDING_SEVERITIES,
} from './constants.js';
import {
  addDaysToDateString,
  getTraceQualityCoverage,
  includedTraceSelection,
  lowCoverageExpr,
  normalizedLimit,
  normalizedOffset,
  traceScoreTargetSql,
} from './queries.js';

// Active thresholds for the current request; reloaded from the local override file (if any) at the
// top of every findings computation, so edits take effect without a restart. Defaults to the
// in-code constants when the file is absent or malformed.
let THRESHOLDS: TraceQualityFindingThresholds = DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge numeric overrides from a parsed config object over the in-code defaults. */
function mergeThresholds(
  base: TraceQualityFindingThresholds,
  override: Record<string, unknown>,
): TraceQualityFindingThresholds {
  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (!(key in merged)) continue;
    const current = merged[key];
    if (typeof current === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      merged[key] = value;
    } else if (isRecord(current) && isRecord(value)) {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subKey in current && typeof current[subKey] === 'number'
          && typeof subValue === 'number' && Number.isFinite(subValue)) {
          current[subKey] = subValue;
        }
      }
    }
  }
  return merged as unknown as TraceQualityFindingThresholds;
}

function loadFindingThresholds(): TraceQualityFindingThresholds {
  const resolved = path.resolve(process.cwd(), config.usage.findingsThresholdsPath);
  if (!fs.existsSync(resolved)) return DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS;
  try {
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as unknown;
    if (!isRecord(raw)) return DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS;
    return mergeThresholds(DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS, raw);
  } catch {
    return DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS;
  }
}

interface FindingSortFields {
  sort_at: string;
  sort_rank: number;
}

type TraceQualityFindingWithSort = TraceQualityFinding & FindingSortFields;

// ─── shared helpers ──────────────────────────────────────────────────────────

/** Linear-interpolated percentile (p in [0,100]); null on empty input. */
function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const low = sorted[lo];
  const high = sorted[hi];
  if (low == null || high == null) return null;
  if (lo === hi) return low;
  return low + (high - low) * (rank - lo);
}

/** Sort key so the most severe finding sorts first (critical → 0 … info → 3). */
function severitySortKey(severity: TraceQualityFindingSeverity): number {
  const index = TRACE_QUALITY_FINDING_SEVERITIES.indexOf(severity);
  return TRACE_QUALITY_FINDING_SEVERITIES.length - 1 - (index < 0 ? 0 : index);
}

function kindSortKey(kind: TraceQualityFindingKind): number {
  const index = TRACE_QUALITY_FINDING_KINDS.indexOf(kind);
  return index < 0 ? TRACE_QUALITY_FINDING_KINDS.length : index;
}

function nowIso(): string {
  return new Date().toISOString();
}

function selectedWindow(params: TraceQualityTraceListParams): TraceQualityFindingWindow {
  return { from: params.date_from ?? null, to: params.date_to ?? null, label: 'selected_range' };
}

function inspection(
  target: TraceQualityFindingInspection['target'],
  params: TraceQualityFindingInspection['params'],
): TraceQualityFindingInspection {
  return { target, params };
}

function cap(ids: readonly string[]): string[] {
  return ids.slice(0, THRESHOLDS.impacted_id_cap);
}

/** Highest matching tier for a "higher is worse" metric; null when below `warning`. */
function gteTier(
  value: number,
  t: { warning: number; high: number; critical?: number },
): TraceQualityFindingSeverity | null {
  if (t.critical != null && value >= t.critical) return 'critical';
  if (value >= t.high) return 'high';
  if (value >= t.warning) return 'warning';
  return null;
}

const ERROR_STATUS_SQL = "o.status IN ('error', 'timeout')";

// Rate-limit markers in an observation's name, status message, or (stringified) metadata.
const RATE_LIMIT_MARKER_SQL = `(
  lower(o.name) LIKE '%rate limit%' OR lower(o.name) LIKE '%rate_limit%'
  OR lower(o.name) LIKE '%429%' OR lower(o.name) LIKE '%overloaded%'
  OR lower(o.name) LIKE '%too many requests%'
  OR lower(COALESCE(o.status_message, '')) LIKE '%rate limit%'
  OR lower(COALESCE(o.status_message, '')) LIKE '%429%'
  OR lower(COALESCE(o.status_message, '')) LIKE '%overloaded%'
  OR lower(o.metadata_json) LIKE '%rate limit%' OR lower(o.metadata_json) LIKE '%rate_limit%'
  OR lower(o.metadata_json) LIKE '%429%' OR lower(o.metadata_json) LIKE '%overloaded%'
)`;

function impactedObservationIds(ctx: FindingContext, conditionSql: string, conditionValues: unknown[] = []): string[] {
  const rows = ctx.db.prepare(`
    SELECT o.id
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND ${conditionSql}
    ORDER BY datetime(COALESCE(o.started_at, o.created_at)), o.id
    LIMIT ?
  `).all(...ctx.selection.values, ...conditionValues, THRESHOLDS.impacted_id_cap) as Array<{ id: string }>;
  return rows.map(row => row.id);
}

// ─── per-kind computers ──────────────────────────────────────────────────────

interface FindingContext {
  db: ReturnType<typeof getDb>;
  params: TraceQualityTraceListParams;
  selection: { sql: string; values: unknown[] };
}

function observationErrorFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const rows = ctx.db.prepare(`
    SELECT
      o.id AS observation_id,
      o.trace_id,
      o.name,
      o.status,
      o.severity,
      COALESCE(o.started_at, o.created_at) AS sort_at
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND (o.status IN ('error', 'timeout') OR o.severity IN ('error', 'critical'))
    ORDER BY datetime(COALESCE(o.started_at, o.created_at)), o.id
  `).all(...ctx.selection.values) as Array<{
    observation_id: string;
    trace_id: string;
    name: string;
    status: string | null;
    severity: string | null;
    sort_at: string;
  }>;

  return rows.map(row => {
    const severity: TraceQualityFindingSeverity = row.severity === 'critical' ? 'critical' : 'high';
    return {
      id: `observation_error:${row.observation_id}`,
      kind: 'observation_error' as const,
      severity,
      trace_id: row.trace_id,
      observation_id: row.observation_id,
      score_id: null,
      title: `${row.name} reported ${row.status ?? row.severity ?? 'an error'}`,
      message: 'An observation has an error or critical status and should be reviewed.',
      evidence: {
        status: row.status,
        severity: row.severity,
        next_inspection: inspection('observation', { trace_id: row.trace_id, observation_id: row.observation_id }),
      },
      created_at: row.sort_at,
      sort_at: row.sort_at,
      sort_rank: kindSortKey('observation_error'),
    };
  });
}

function lowQualityScoreFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.low_quality_score;
  const threshold = ctx.params.max_score ?? t.warning;
  const rows = ctx.db.prepare(`
    SELECT
      score_targets.id,
      score_targets.name,
      score_targets.numeric_value,
      score_targets.resolved_trace_id AS trace_id,
      score_targets.resolved_observation_id AS observation_id,
      score_targets.created_at
    FROM (${traceScoreTargetSql()}) score_targets
    WHERE score_targets.resolved_trace_id IN (${ctx.selection.sql})
      AND score_targets.numeric_value IS NOT NULL
      AND score_targets.numeric_value <= ?
    ORDER BY score_targets.numeric_value, score_targets.created_at, score_targets.id
  `).all(...ctx.selection.values, threshold) as Array<{
    id: number;
    name: string;
    numeric_value: number;
    trace_id: string;
    observation_id: string | null;
    created_at: string;
  }>;

  return rows.map(row => {
    const severity: TraceQualityFindingSeverity =
      row.numeric_value <= t.critical ? 'critical' : row.numeric_value <= t.high ? 'high' : 'warning';
    return {
      id: `low_quality_score:${row.id}`,
      kind: 'low_quality_score' as const,
      severity,
      trace_id: row.trace_id,
      observation_id: row.observation_id,
      score_id: row.id,
      title: `${row.name} score is low`,
      message: `Numeric score ${row.numeric_value} is at or below ${threshold}.`,
      evidence: {
        metric_value: row.numeric_value,
        threshold,
        comparator: 'lte',
        unit: 'ratio',
        dimension: { type: 'score', value: row.name },
        next_inspection: row.observation_id
          ? inspection('observation', { trace_id: row.trace_id, observation_id: row.observation_id })
          : inspection('trace', { trace_id: row.trace_id }),
      },
      created_at: row.created_at,
      sort_at: row.created_at,
      sort_rank: kindSortKey('low_quality_score'),
    };
  });
}

function lowTraceCoverageFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.low_trace_coverage;
  const counts = ctx.db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ${lowCoverageExpr('t')} THEN 1 ELSE 0 END), 0) AS low
    FROM trace_quality_traces t
    WHERE t.id IN (${ctx.selection.sql})
  `).get(...ctx.selection.values) as { total: number; low: number };

  if (counts.total < t.min_traces || counts.low === 0) return [];
  const ratio = counts.low / counts.total;
  const severity: TraceQualityFindingSeverity = ratio >= t.high ? 'high' : ratio >= t.warning ? 'warning' : 'info';
  if (severity === 'info') return [];

  const impactedRows = ctx.db.prepare(`
    SELECT t.id
    FROM trace_quality_traces t
    WHERE t.id IN (${ctx.selection.sql})
      AND ${lowCoverageExpr('t')}
    ORDER BY datetime(COALESCE(t.started_at, t.created_at)), t.id
    LIMIT ?
  `).all(...ctx.selection.values, THRESHOLDS.impacted_id_cap) as Array<{ id: string }>;

  return [{
    id: 'low_trace_coverage',
    kind: 'low_trace_coverage' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'Traces have low projection coverage',
    message: `${counts.low} of ${counts.total} selected traces were projected from partial source data.`,
    evidence: {
      metric_value: ratio,
      threshold: t.warning,
      comparator: 'gte',
      unit: 'ratio',
      sample_size: counts.total,
      window: selectedWindow(ctx.params),
      impacted_trace_ids: cap(impactedRows.map(row => row.id)),
      impacted_total: counts.low,
      next_inspection: inspection('traces', { exclude_low_coverage: false }),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('low_trace_coverage'),
  }];
}

function highErrorRateFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.high_error_rate;
  const row = ctx.db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ${ERROR_STATUS_SQL} THEN 1 ELSE 0 END), 0) AS errors
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
  `).get(...ctx.selection.values) as { total: number; errors: number };

  if (row.total < t.min_observations) return [];
  const ratio = row.errors / row.total;
  const severity = gteTier(ratio, t);
  if (!severity) return [];

  return [{
    id: 'high_error_rate',
    kind: 'high_error_rate' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'Elevated observation error rate',
    message: `${row.errors} of ${row.total} observations failed (${(ratio * 100).toFixed(1)}%).`,
    evidence: {
      metric_value: ratio,
      threshold: t.warning,
      comparator: 'gte',
      unit: 'ratio',
      sample_size: row.total,
      window: selectedWindow(ctx.params),
      impacted_observation_ids: cap(impactedObservationIds(ctx, ERROR_STATUS_SQL)),
      impacted_total: row.errors,
      next_inspection: inspection('traces', { status: 'error' }),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('high_error_rate'),
  }];
}

function dimensionErrorFindings(
  ctx: FindingContext,
  config: {
    kind: Extract<TraceQualityFindingKind, 'tool_failure_rate' | 'model_error_rate'>;
    column: 'tool_name' | 'model';
    dimensionType: 'tool' | 'model';
    inspectionParam: 'tool' | 'model';
    thresholds: { warning: number; high: number; critical: number; min_calls: number };
    label: string;
  },
): TraceQualityFindingWithSort[] {
  const { column, thresholds: t } = config;
  const rows = ctx.db.prepare(`
    SELECT
      o.${column} AS dimension,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ${ERROR_STATUS_SQL} THEN 1 ELSE 0 END), 0) AS errors
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND o.${column} IS NOT NULL AND o.${column} <> ''
    GROUP BY o.${column}
    ORDER BY o.${column}
  `).all(...ctx.selection.values) as Array<{ dimension: string; total: number; errors: number }>;

  const findings: TraceQualityFindingWithSort[] = [];
  for (const row of rows) {
    if (row.total < t.min_calls) continue;
    const ratio = row.errors / row.total;
    const severity = gteTier(ratio, t);
    if (!severity) continue;

    findings.push({
      id: `${config.kind}:${row.dimension}`,
      kind: config.kind,
      severity,
      trace_id: null,
      observation_id: null,
      score_id: null,
      title: `${config.label} "${row.dimension}" has a high error rate`,
      message: `${row.errors} of ${row.total} ${config.label.toLowerCase()} calls for "${row.dimension}" failed (${(ratio * 100).toFixed(1)}%).`,
      evidence: {
        metric_value: ratio,
        threshold: t.warning,
        comparator: 'gte',
        unit: 'ratio',
        sample_size: row.total,
        window: selectedWindow(ctx.params),
        dimension: { type: config.dimensionType, value: row.dimension },
        impacted_observation_ids: cap(impactedObservationIds(
          ctx,
          `o.${column} = ? AND ${ERROR_STATUS_SQL}`,
          [row.dimension],
        )),
        impacted_total: row.errors,
        next_inspection: inspection('traces', { [config.inspectionParam]: row.dimension }),
      },
      created_at: nowIso(),
      sort_at: nowIso(),
      sort_rank: kindSortKey(config.kind),
    });
  }
  return findings;
}

function rateLimitFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.rate_limit_events;
  const row = ctx.db.prepare(`
    SELECT COUNT(*) AS count
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND ${RATE_LIMIT_MARKER_SQL}
  `).get(...ctx.selection.values) as { count: number };

  const severity = gteTier(row.count, t);
  if (!severity) return [];

  return [{
    id: 'rate_limit_events',
    kind: 'rate_limit_events' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'Rate-limit activity detected',
    message: `${row.count} observation(s) show rate-limit markers (429 / "rate limit" / "overloaded").`,
    evidence: {
      metric_value: row.count,
      threshold: t.warning,
      comparator: 'gte',
      unit: 'count',
      window: selectedWindow(ctx.params),
      impacted_observation_ids: cap(impactedObservationIds(ctx, RATE_LIMIT_MARKER_SQL)),
      impacted_total: row.count,
      next_inspection: inspection('traces', {}),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('rate_limit_events'),
  }];
}

// ─── latency findings ────────────────────────────────────────────────────────

/** Day → duration_ms[] for selected observations, keyed by UTC calendar day. */
function durationsByDay(ctx: FindingContext): Map<string, number[]> {
  const rows = ctx.db.prepare(`
    SELECT substr(COALESCE(o.started_at, o.created_at), 1, 10) AS day, o.duration_ms AS d
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND o.duration_ms IS NOT NULL
  `).all(...ctx.selection.values) as Array<{ day: string; d: number }>;

  const byDay = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.day) continue;
    const list = byDay.get(row.day) ?? [];
    list.push(row.d);
    byDay.set(row.day, list);
  }
  return byDay;
}

function highLatencyP95Findings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.high_latency_p95;
  const byDay = durationsByDay(ctx);
  const durations = [...byDay.values()].flat();
  if (durations.length < t.min_samples) return [];

  const p95 = percentile(durations, 95);
  if (p95 == null) return [];
  const severity = gteTier(p95, { warning: t.warning_ms, high: t.high_ms, critical: t.critical_ms });
  if (!severity) return [];

  return [{
    id: 'high_latency_p95',
    kind: 'high_latency_p95' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'High p95 observation latency',
    message: `p95 duration is ${Math.round(p95)}ms across ${durations.length} observations.`,
    evidence: {
      metric_value: Math.round(p95),
      threshold: t.warning_ms,
      comparator: 'gte',
      unit: 'ms',
      sample_size: durations.length,
      window: selectedWindow(ctx.params),
      next_inspection: inspection('traces', {}),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('high_latency_p95'),
  }];
}

function latencySpikeFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.latency_spike;
  const byDay = durationsByDay(ctx);
  if (byDay.size < t.min_days) return [];

  const latestDay = [...byDay.keys()].sort().at(-1);
  if (!latestDay) return [];
  const baselineStart = addDaysToDateString(latestDay, -THRESHOLDS.baseline_window_days);

  const latest = byDay.get(latestDay) ?? [];
  const baseline = [...byDay.entries()]
    .filter(([day]) => day < latestDay && (baselineStart == null || day >= baselineStart))
    .flatMap(([, values]) => values);

  if (latest.length < t.min_samples_per_window || baseline.length < t.min_samples_per_window) return [];

  const latestP95 = percentile(latest, 95);
  const baselineP95 = percentile(baseline, 95);
  if (latestP95 == null || baselineP95 == null || baselineP95 <= 0) return [];

  const ratio = latestP95 / baselineP95;
  const severity = gteTier(ratio, { warning: t.warning_ratio, high: t.high_ratio });
  if (!severity) return [];

  return [{
    id: 'latency_spike',
    kind: 'latency_spike' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'Latency spike vs. recent baseline',
    message: `Latest-day p95 (${Math.round(latestP95)}ms) is ${ratio.toFixed(1)}× the trailing baseline (${Math.round(baselineP95)}ms).`,
    evidence: {
      metric_value: ratio,
      threshold: t.warning_ratio,
      comparator: 'gte',
      unit: 'ratio',
      sample_size: latest.length,
      baseline_value: Math.round(baselineP95),
      window: { from: latestDay, to: latestDay, label: 'latest_day' },
      baseline_window: { from: baselineStart, to: latestDay, label: 'baseline_7d' },
      latest_p95_ms: Math.round(latestP95),
      next_inspection: inspection('traces', { date_from: latestDay }),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('latency_spike'),
  }];
}

// ─── volume-anomaly findings ─────────────────────────────────────────────────

/** Day → summed metric for selected observations (valueExpr is a SQL aggregate argument). */
function dailySums(ctx: FindingContext, valueExpr: string): Map<string, number> {
  const rows = ctx.db.prepare(`
    SELECT substr(COALESCE(o.started_at, o.created_at), 1, 10) AS day, COALESCE(SUM(${valueExpr}), 0) AS v
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
    GROUP BY day
  `).all(...ctx.selection.values) as Array<{ day: string; v: number }>;

  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.day) byDay.set(row.day, row.v);
  }
  return byDay;
}

function dailySpikeFinding(
  ctx: FindingContext,
  config: {
    kind: Extract<TraceQualityFindingKind, 'token_spike' | 'cost_anomaly'>;
    valueExpr: string;
    unit: 'tokens' | 'usd';
    minBaselineDays: number;
    minBaselineAvg: number;
    tiers: { warning: number; high: number; critical?: number };
    title: string;
    describe: (latest: number, ratio: number, baselineAvg: number) => string;
  },
): TraceQualityFindingWithSort[] {
  const byDay = dailySums(ctx, config.valueExpr);
  if (byDay.size < config.minBaselineDays + 1) return [];

  const latestDay = [...byDay.keys()].sort().at(-1);
  if (!latestDay) return [];
  const baselineStart = addDaysToDateString(latestDay, -THRESHOLDS.baseline_window_days);

  const baselineDays = [...byDay.entries()]
    .filter(([day]) => day < latestDay && (baselineStart == null || day >= baselineStart));
  if (baselineDays.length < config.minBaselineDays) return [];

  const latestSum = byDay.get(latestDay) ?? 0;
  const baselineAvg = baselineDays.reduce((sum, [, v]) => sum + v, 0) / baselineDays.length;
  if (baselineAvg < config.minBaselineAvg) return [];

  const ratio = latestSum / baselineAvg;
  const severity = gteTier(ratio, config.tiers);
  if (!severity) return [];

  return [{
    id: config.kind,
    kind: config.kind,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: config.title,
    message: config.describe(latestSum, ratio, baselineAvg),
    evidence: {
      metric_value: ratio,
      threshold: config.tiers.warning,
      comparator: 'gte',
      unit: 'ratio',
      sample_size: baselineDays.length,
      baseline_value: baselineAvg,
      latest_value: latestSum,
      latest_unit: config.unit,
      window: { from: latestDay, to: latestDay, label: 'latest_day' },
      baseline_window: { from: baselineStart, to: latestDay, label: 'baseline_7d' },
      next_inspection: inspection('traces', { date_from: latestDay }),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey(config.kind),
  }];
}

// ─── pricing and telemetry findings ──────────────────────────────────────────

const USAGE_BEARING_SQL = "(o.observation_type = 'generation' OR (o.tokens_in + o.tokens_out) > 0)";

function unknownPricingFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.unknown_pricing;
  const row = ctx.db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN o.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND ${USAGE_BEARING_SQL}
  `).get(...ctx.selection.values) as { total: number; unknown: number };

  if (row.total < t.min_observations || row.unknown === 0) return [];
  const ratio = row.unknown / row.total;
  const severity = gteTier(ratio, t);
  if (!severity) return [];

  const models = (ctx.db.prepare(`
    SELECT DISTINCT o.model
    FROM trace_quality_observations o
    WHERE o.trace_id IN (${ctx.selection.sql})
      AND ${USAGE_BEARING_SQL}
      AND o.cost_usd IS NULL
      AND o.model IS NOT NULL
    ORDER BY o.model
    LIMIT ?
  `).all(...ctx.selection.values, THRESHOLDS.impacted_id_cap) as Array<{ model: string }>).map(r => r.model);

  return [{
    id: 'unknown_pricing',
    kind: 'unknown_pricing' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'Usage with unknown pricing',
    message: `${row.unknown} of ${row.total} usage-bearing observations have no resolved cost.`,
    evidence: {
      metric_value: ratio,
      threshold: t.warning,
      comparator: 'gte',
      unit: 'ratio',
      sample_size: row.total,
      window: selectedWindow(ctx.params),
      impacted_observation_ids: cap(impactedObservationIds(ctx, `${USAGE_BEARING_SQL} AND o.cost_usd IS NULL`)),
      impacted_total: row.unknown,
      models,
      next_inspection: inspection('traces', {}),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('unknown_pricing'),
  }];
}

function otelDropoffFindings(ctx: FindingContext): TraceQualityFindingWithSort[] {
  const t = THRESHOLDS.collector_or_otel_dropoff;
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (ctx.params.project) { conditions.push('project = ?'); values.push(ctx.params.project); }
  if (ctx.params.agent) { conditions.push('agent_type = ?'); values.push(ctx.params.agent); }
  if (ctx.params.date_from) { conditions.push('ts >= ?'); values.push(ctx.params.date_from); }
  if (ctx.params.date_to) { conditions.push('ts <= ?'); values.push(ctx.params.date_to); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = ctx.db.prepare(`
    SELECT
      MAX(CASE WHEN source = 'otel' THEN ts END) AS last_otel,
      MAX(CASE WHEN source IS NULL OR source <> 'otel' THEN ts END) AS last_other,
      COALESCE(SUM(CASE WHEN source = 'otel' THEN 1 ELSE 0 END), 0) AS otel_count
    FROM (
      SELECT source, COALESCE(client_timestamp, created_at) AS ts, project, agent_type
      FROM events
    )
    ${where}
  `).get(...values) as { last_otel: string | null; last_other: string | null; otel_count: number };

  // Require prior otel history AND activity that continued after otel stopped.
  if (row.otel_count === 0 || !row.last_otel || !row.last_other || row.last_other <= row.last_otel) return [];

  const gapMinutes = (Date.parse(row.last_other) - Date.parse(row.last_otel)) / 60000;
  if (!Number.isFinite(gapMinutes)) return [];
  const severity = gteTier(gapMinutes, { warning: t.warning_minutes, high: t.high_minutes });
  if (!severity) return [];

  return [{
    id: 'collector_or_otel_dropoff',
    kind: 'collector_or_otel_dropoff' as const,
    severity,
    trace_id: null,
    observation_id: null,
    score_id: null,
    title: 'OTEL telemetry drop-off',
    message: `OTEL telemetry stopped ${Math.round(gapMinutes)} min before the latest non-OTEL activity; the collector or exporter config may be stale.`,
    evidence: {
      metric_value: Math.round(gapMinutes),
      threshold: t.warning_minutes,
      comparator: 'gte',
      unit: 'minutes',
      last_otel_at: row.last_otel,
      last_activity_at: row.last_other,
      otel_event_count: row.otel_count,
      next_inspection: inspection('usage', {}),
    },
    created_at: nowIso(),
    sort_at: nowIso(),
    sort_rank: kindSortKey('collector_or_otel_dropoff'),
  }];
}

// ─── budget-risk findings ────────────────────────────────────────────────────

function budgetSeverity(state: UsageBudgetAlertState): TraceQualityFindingSeverity | null {
  switch (state) {
    case 'hard_stop_candidate': return 'critical';
    case 'critical': return 'high';
    case 'warning': return 'warning';
    case 'info': return 'info';
    default: return null;
  }
}

function budgetRiskFindings(): TraceQualityFindingWithSort[] {
  const { data } = getUsageBudgets();
  const findings: TraceQualityFindingWithSort[] = [];
  for (const budget of data) {
    const severity = budgetSeverity(budget.state);
    if (!severity) continue;
    findings.push({
      id: `daily_budget_risk:${budget.name}`,
      kind: 'daily_budget_risk' as const,
      severity,
      trace_id: null,
      observation_id: null,
      score_id: null,
      title: `Budget "${budget.name}" at ${budget.percent_used}% of limit`,
      message: `$${budget.spent_usd.toFixed(2)} of $${budget.limit_usd.toFixed(2)} (${budget.period}) used.`,
      evidence: {
        metric_value: budget.percent_used,
        threshold: budget.thresholds.warning,
        comparator: 'gte',
        unit: 'usd',
        dimension: { type: 'budget', value: budget.name },
        spent_usd: budget.spent_usd,
        limit_usd: budget.limit_usd,
        remaining_usd: budget.remaining_usd,
        period: budget.period,
        budget_state: budget.state,
        window: { from: budget.date_from, to: budget.date_to, label: budget.period },
        next_inspection: inspection('usage', {}),
      },
      created_at: nowIso(),
      sort_at: nowIso(),
      sort_rank: kindSortKey('daily_budget_risk'),
    });
  }
  return findings;
}

// ─── public API ──────────────────────────────────────────────────────────────

function computeTraceQualityFindings(
  params: TraceQualityTraceListParams = {},
): TraceQualityFindingWithSort[] {
  THRESHOLDS = loadFindingThresholds();
  const ctx: FindingContext = {
    db: getDb(),
    params,
    selection: includedTraceSelection(params),
  };

  return [
    ...highErrorRateFindings(ctx),
    ...dimensionErrorFindings(ctx, {
      kind: 'tool_failure_rate',
      column: 'tool_name',
      dimensionType: 'tool',
      inspectionParam: 'tool',
      thresholds: THRESHOLDS.tool_failure_rate,
      label: 'Tool',
    }),
    ...dimensionErrorFindings(ctx, {
      kind: 'model_error_rate',
      column: 'model',
      dimensionType: 'model',
      inspectionParam: 'model',
      thresholds: THRESHOLDS.model_error_rate,
      label: 'Model',
    }),
    ...rateLimitFindings(ctx),
    ...highLatencyP95Findings(ctx),
    ...latencySpikeFindings(ctx),
    ...dailySpikeFinding(ctx, {
      kind: 'token_spike',
      valueExpr: 'o.tokens_in + o.tokens_out',
      unit: 'tokens',
      minBaselineDays: THRESHOLDS.token_spike.min_baseline_days,
      minBaselineAvg: 1,
      tiers: { warning: THRESHOLDS.token_spike.warning_ratio, high: THRESHOLDS.token_spike.high_ratio },
      title: 'Token usage spike vs. recent baseline',
      describe: (latest, ratio, avg) =>
        `Latest-day tokens (${latest}) are ${ratio.toFixed(1)}× the trailing daily average (${Math.round(avg)}).`,
    }),
    ...dailySpikeFinding(ctx, {
      kind: 'cost_anomaly',
      valueExpr: 'COALESCE(o.cost_usd, 0)',
      unit: 'usd',
      minBaselineDays: THRESHOLDS.cost_anomaly.min_baseline_days,
      minBaselineAvg: THRESHOLDS.cost_anomaly.min_baseline_avg_usd,
      tiers: {
        warning: THRESHOLDS.cost_anomaly.warning_ratio,
        high: THRESHOLDS.cost_anomaly.high_ratio,
        critical: THRESHOLDS.cost_anomaly.critical_ratio,
      },
      title: 'Cost anomaly vs. recent baseline',
      describe: (latest, ratio, avg) =>
        `Latest-day cost ($${latest.toFixed(2)}) is ${ratio.toFixed(1)}× the trailing daily average ($${avg.toFixed(2)}).`,
    }),
    ...unknownPricingFindings(ctx),
    ...otelDropoffFindings(ctx),
    ...budgetRiskFindings(),
    ...observationErrorFindings(ctx),
    ...lowQualityScoreFindings(ctx),
    ...lowTraceCoverageFindings(ctx),
  ];
}

export function listTraceQualityFindings(params: TraceQualityTraceListParams = {}): {
  data: TraceQualityFinding[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
} {
  const limit = normalizedLimit(params.limit, 100, 500);
  const offset = normalizedOffset(params.offset);

  const findings = computeTraceQualityFindings(params).sort((a, b) =>
    severitySortKey(a.severity) - severitySortKey(b.severity)
    || a.sort_rank - b.sort_rank
    || a.sort_at.localeCompare(b.sort_at)
    || a.id.localeCompare(b.id),
  );

  return {
    data: findings
      .slice(offset, offset + limit)
      .map(({ sort_at: _sortAt, sort_rank: _sortRank, ...finding }) => finding),
    total: findings.length,
    limit,
    offset,
    coverage: getTraceQualityCoverage(params),
  };
}
