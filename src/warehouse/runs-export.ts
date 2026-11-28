import { randomUUID } from 'node:crypto';

import { packageVersion } from '../cli/package.js';
import {
  TRACE_QUALITY_COST_COVERAGES,
  TRACE_QUALITY_COST_PROVENANCES,
  TRACE_QUALITY_TIMESTAMP_COVERAGES,
  TRACE_QUALITY_TOOL_OUTCOME_COVERAGES,
  TRACE_QUALITY_USAGE_COVERAGES,
} from '../trace-quality/constants.js';
import type {
  TraceQualityCostCoverage,
  TraceQualityCostProvenance,
  TraceQualityCoverage,
  TraceQualityTimestampCoverage,
  TraceQualityToolOutcomeCoverage,
  TraceQualityUsageCoverage,
} from '../trace-quality/types.js';
import type { WarehouseSessionTraceSummaryRow } from './source.js';
import type { PublishLineage, WarehouseRunRow } from './types.js';

const RUN_ROW_KEYS = [
  'account',
  'session_id',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
  'latency_ms',
  'observation_count',
  'error_count',
  'quality_score',
  'quality_grade',
  'project',
  'agent_type',
  'started_at',
  'day',
  'published_run_id',
  'usage_coverage',
  'cost_coverage',
  'cost_provenance',
  'timestamp_coverage',
  'tool_outcome_coverage',
  'has_full_transcript',
] as const satisfies readonly (keyof WarehouseRunRow)[];

const RUN_ROW_KEY_SET = new Set<string>(RUN_ROW_KEYS);
const USAGE_COVERAGE_SET = new Set<string>(TRACE_QUALITY_USAGE_COVERAGES);
const COST_COVERAGE_SET = new Set<string>(TRACE_QUALITY_COST_COVERAGES);
const COST_PROVENANCE_SET = new Set<string>(TRACE_QUALITY_COST_PROVENANCES);
const TIMESTAMP_COVERAGE_SET = new Set<string>(TRACE_QUALITY_TIMESTAMP_COVERAGES);
const TOOL_OUTCOME_COVERAGE_SET = new Set<string>(TRACE_QUALITY_TOOL_OUTCOME_COVERAGES);

export interface MinBatchResult {
  published: WarehouseRunRow[];
  suppressed: WarehouseRunRow[];
}

export interface BuildLineageParams {
  runId?: string;
  createdAt?: string;
  account: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  sessionsPublished: number;
  sessionsSuppressed: number;
  minBatch: number;
  grantRole: string | null;
  grantSkipped?: boolean;
}

function parseTimestamp(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T00:00:00.000Z`
      : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid summary timestamp: ${value}`);
  return parsed;
}

function toIsoTimestamp(value: string): string {
  return parseTimestamp(value).toISOString();
}

function dayFromTimestamp(value: string): string {
  return parseTimestamp(value).toISOString().slice(0, 10);
}

function assertShortString(field: string, value: unknown, maxLength = 128): void {
  if (value == null) return;
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`Warehouse row field ${field} is not a safe bounded string`);
  }
}

function assertOpaqueId(field: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\r\n]/.test(value)) {
    throw new Error(`Warehouse row field ${field} is not a safe opaque id`);
  }
}

function assertIsoTimestamp(field: string, value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`Warehouse row field ${field} is not an ISO timestamp`);
  }
}

function assertDate(field: string, value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`Warehouse row field ${field} is not a date`);
  }
}

function assertNumber(field: string, value: unknown, nullable = false): void {
  if (value == null && nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Warehouse row field ${field} is not numeric`);
  }
}

function parseCoverageJson(raw: string | null | undefined): TraceQualityCoverage {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as TraceQualityCoverage
      : {};
  } catch {
    return {};
  }
}

function assertEnum(field: string, value: unknown, allowed: ReadonlySet<string>): void {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`Warehouse row field ${field} is not an allowlisted coverage value`);
  }
}

function resolveCoverageForExport(summary: WarehouseSessionTraceSummaryRow): {
  usage_coverage: TraceQualityUsageCoverage;
  cost_coverage: TraceQualityCostCoverage;
  cost_provenance: TraceQualityCostProvenance;
  timestamp_coverage: TraceQualityTimestampCoverage;
  tool_outcome_coverage: TraceQualityToolOutcomeCoverage;
  has_full_transcript: boolean;
} {
  const coverage = parseCoverageJson(summary.coverage_json);
  const tokenTotal = summary.tokens_in + summary.tokens_out + summary.cache_read_tokens + summary.cache_write_tokens;

  const usage_coverage: TraceQualityUsageCoverage =
    typeof coverage.usage_coverage === 'string' && USAGE_COVERAGE_SET.has(coverage.usage_coverage)
      ? coverage.usage_coverage
      : coverage.has_token_usage === true
        ? (tokenTotal > 0 ? 'observed' : 'observed_zero')
        : (tokenTotal > 0 ? 'observed' : 'unavailable');

  const cost_coverage: TraceQualityCostCoverage =
    typeof coverage.cost_coverage === 'string' && COST_COVERAGE_SET.has(coverage.cost_coverage)
      ? coverage.cost_coverage
      : coverage.has_cost === true
        ? 'priced'
        : usage_coverage === 'unavailable'
          ? 'unavailable'
          : summary.cost_usd > 0 ? 'priced' : 'unpriced';

  const cost_provenance: TraceQualityCostProvenance =
    typeof coverage.cost_provenance === 'string' && COST_PROVENANCE_SET.has(coverage.cost_provenance)
      ? coverage.cost_provenance
      : cost_coverage === 'unavailable' || cost_coverage === 'unpriced'
        ? 'unavailable'
        : 'unknown';

  const timestamp_coverage: TraceQualityTimestampCoverage =
    typeof coverage.timestamp_coverage === 'string' && TIMESTAMP_COVERAGE_SET.has(coverage.timestamp_coverage)
      ? coverage.timestamp_coverage
      : summary.started_at != null ? 'approximate' : 'unavailable';

  const tool_outcome_coverage: TraceQualityToolOutcomeCoverage =
    typeof coverage.tool_outcome_coverage === 'string' && TOOL_OUTCOME_COVERAGE_SET.has(coverage.tool_outcome_coverage)
      ? coverage.tool_outcome_coverage
      : coverage.has_tool_details === true ? 'unrecorded' : 'not_applicable';

  return {
    usage_coverage,
    cost_coverage,
    cost_provenance,
    timestamp_coverage,
    tool_outcome_coverage,
    has_full_transcript: coverage.has_full_transcript === true,
  };
}

export function mapSummaryToRunRow(
  summary: WarehouseSessionTraceSummaryRow,
  account: string,
  runId: string,
): WarehouseRunRow {
  const effectiveStartedAt = summary.started_at ?? summary.updated_at;
  const startedAt = toIsoTimestamp(effectiveStartedAt);
  const coverage = resolveCoverageForExport(summary);
  const usageObserved = coverage.usage_coverage !== 'unavailable';
  const costObserved = coverage.cost_coverage === 'priced' || coverage.cost_coverage === 'partial';
  return {
    account,
    session_id: summary.session_id,
    model: summary.primary_model,
    input_tokens: usageObserved ? summary.tokens_in : null,
    output_tokens: usageObserved ? summary.tokens_out : null,
    cache_read_tokens: usageObserved ? summary.cache_read_tokens : null,
    cache_write_tokens: usageObserved ? summary.cache_write_tokens : null,
    cost_usd: costObserved ? summary.cost_usd : null,
    latency_ms: summary.latency_ms_total,
    observation_count: summary.observation_count,
    error_count: summary.error_count,
    quality_score: summary.quality_score,
    quality_grade: summary.quality_grade,
    project: summary.project,
    agent_type: summary.agent_type,
    started_at: startedAt,
    day: dayFromTimestamp(startedAt),
    published_run_id: runId,
    usage_coverage: coverage.usage_coverage,
    cost_coverage: coverage.cost_coverage,
    cost_provenance: coverage.cost_provenance,
    timestamp_coverage: coverage.timestamp_coverage,
    tool_outcome_coverage: coverage.tool_outcome_coverage,
    has_full_transcript: coverage.has_full_transcript,
  };
}

export function assertContentFree(row: WarehouseRunRow): void {
  const keys = Object.keys(row);
  if (keys.length !== RUN_ROW_KEYS.length || keys.some(key => !RUN_ROW_KEY_SET.has(key))) {
    throw new Error('Warehouse row keys do not match the content-free allowlist');
  }
  for (const key of RUN_ROW_KEYS) {
    if (!Object.hasOwn(row, key)) {
      throw new Error(`Warehouse row is missing allowlisted field ${key}`);
    }
  }

  assertShortString('account', row.account);
  assertShortString('model', row.model);
  assertShortString('project', row.project);
  assertShortString('agent_type', row.agent_type);
  assertShortString('quality_grade', row.quality_grade, 16);
  assertOpaqueId('session_id', row.session_id);
  assertOpaqueId('published_run_id', row.published_run_id);
  assertIsoTimestamp('started_at', row.started_at);
  assertDate('day', row.day);

  assertEnum('usage_coverage', row.usage_coverage, USAGE_COVERAGE_SET);
  assertEnum('cost_coverage', row.cost_coverage, COST_COVERAGE_SET);
  assertEnum('cost_provenance', row.cost_provenance, COST_PROVENANCE_SET);
  assertEnum('timestamp_coverage', row.timestamp_coverage, TIMESTAMP_COVERAGE_SET);
  assertEnum('tool_outcome_coverage', row.tool_outcome_coverage, TOOL_OUTCOME_COVERAGE_SET);
  if (typeof row.has_full_transcript !== 'boolean') {
    throw new Error('Warehouse row field has_full_transcript is not boolean');
  }

  if (row.usage_coverage === 'unavailable') {
    if (
      row.input_tokens !== null
      || row.output_tokens !== null
      || row.cache_read_tokens !== null
      || row.cache_write_tokens !== null
    ) {
      throw new Error('Warehouse row tokens must be null when usage_coverage is unavailable');
    }
  } else {
    assertNumber('input_tokens', row.input_tokens);
    assertNumber('output_tokens', row.output_tokens);
    assertNumber('cache_read_tokens', row.cache_read_tokens);
    assertNumber('cache_write_tokens', row.cache_write_tokens);
  }

  if (row.cost_coverage === 'unavailable' || row.cost_coverage === 'unpriced') {
    if (row.cost_usd !== null) {
      throw new Error('Warehouse row cost_usd must be null when cost_coverage is unavailable or unpriced');
    }
  } else {
    assertNumber('cost_usd', row.cost_usd);
  }

  assertNumber('latency_ms', row.latency_ms);
  assertNumber('observation_count', row.observation_count);
  assertNumber('error_count', row.error_count);
  assertNumber('quality_score', row.quality_score, true);
}

export function applyMinBatch(rows: readonly WarehouseRunRow[], minBatch = 0): MinBatchResult {
  const normalized = Math.max(0, Math.floor(minBatch));
  if (normalized > 0 && rows.length < normalized) {
    return { published: [], suppressed: [...rows] };
  }
  return { published: [...rows], suppressed: [] };
}

export function buildLineage(params: BuildLineageParams): PublishLineage {
  return {
    run_id: params.runId ?? `amon-${randomUUID()}`,
    created_at: params.createdAt ?? new Date().toISOString(),
    account: params.account,
    window_start: params.windowStart ?? null,
    window_end: params.windowEnd ?? null,
    sessions_published: params.sessionsPublished,
    sessions_suppressed: params.sessionsSuppressed,
    min_batch: Math.max(0, Math.floor(params.minBatch)),
    amon_version: packageVersion(),
    grant_role: params.grantRole,
    grant_skipped: params.grantSkipped ?? false,
  };
}
