/**
 * session_trace_summary — the lean, content-free, export-shaped per-session
 * rollup that replaces the persisted trace/observation warehouse for list and
 * aggregate views (see docs/system/trace-quality.md).
 *
 * One row per session: token/cost/latency rollups, telemetry coverage, and a
 * single derived quality scalar. No message text — this row is safe to export
 * (its columns map to medallion's `silver.agent_runs`). The full observation
 * tree is NOT persisted; detail is projected on-demand (Phase 2).
 */
import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { getDb } from '../db/connection.js';
import {
  classifyEventTimestampCoverage,
  classifyToolOutcomeCounts,
  coverageForEvents,
  isMeasuredUsageEvent,
  projectTraceQuality,
  type EventCoverageInput,
  type EventProjectionSource,
  type ProjectedTraceQualityObservation,
  type ProjectedTraceQualityTrace,
} from './projection.js';
import { readTraceQualityProjectionInputForSession } from './source-readers.js';
import type {
  TraceQualityCostCoverage,
  TraceQualityCostProvenance,
  TraceQualityCoverage,
  TraceQualityTimestampCoverage,
  TraceQualityToolOutcomeCoverage,
  TraceQualityUsageCoverage,
} from './types.js';

/**
 * Version stamp for the summary derivation (distinct from the projection
 * version). Bump it whenever `deriveSessionTraceSummary` / the quality formula
 * changes; the startup guard re-backfills every row whose stored version
 * differs, so derivation changes propagate without a manual reset.
 */
const SESSION_TRACE_SUMMARY_VERSION = 'sts:v6';

/**
 * Stable, deterministic trace id for a session. The lean view presents one trace
 * per session; this id is persisted on `session_trace_summary` so the on-demand
 * read layer can emit it (the list row's `id`) and reverse it back to a session
 * for the detail/observation endpoints. A non-reversible hash, so the reverse
 * lookup is a column read, not a recomputation.
 */
export function sessionTraceId(sessionId: string): string {
  return `sts:${createHash('sha1').update(sessionId).digest('hex').slice(0, 24)}`;
}

export interface SessionTraceSummary {
  session_id: string;
  agent_type: string | null;
  project: string | null;
  primary_model: string | null;
  started_at: string | null;
  ended_at: string | null;
  observation_count: number;
  error_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  latency_ms_total: number;
  coverage: TraceQualityCoverage;
  quality_score: number | null;
  quality_grade: string | null;
}

const CONFIDENCE_WEIGHT: Record<string, number> = { high: 1, medium: 0.8, low: 0.6, unknown: 0.6 };

/**
 * Merge the coverage flags across a session's traces: a flag is present if any
 * trace has it; confidence is the lowest seen (most conservative).
 */
function mergeUsageCoverage(
  a: TraceQualityUsageCoverage | undefined,
  b: TraceQualityUsageCoverage | undefined,
): TraceQualityUsageCoverage {
  if (a === 'observed' || b === 'observed') return 'observed';
  if (a === 'observed_zero' || b === 'observed_zero') return 'observed_zero';
  return 'unavailable';
}

function mergeCostCoverage(
  a: TraceQualityCostCoverage | undefined,
  b: TraceQualityCostCoverage | undefined,
): TraceQualityCostCoverage {
  if (!a || a === 'unavailable') return b ?? 'unavailable';
  if (!b || b === 'unavailable') return a;
  if (a === b) return a;
  return 'partial';
}

function mergeCostProvenance(
  a: TraceQualityCostProvenance | undefined,
  b: TraceQualityCostProvenance | undefined,
): TraceQualityCostProvenance {
  if (!a || a === 'unavailable') return b ?? 'unavailable';
  if (!b || b === 'unavailable') return a;
  if (a === b) return a;
  if ((a === 'reported' && b === 'estimated') || (a === 'estimated' && b === 'reported')) return 'mixed';
  if (a === 'mixed' || b === 'mixed') return 'mixed';
  return 'unknown';
}

function mergeTimestampCoverage(
  a: TraceQualityTimestampCoverage | undefined,
  b: TraceQualityTimestampCoverage | undefined,
): TraceQualityTimestampCoverage {
  if (!a) return b ?? 'unavailable';
  if (!b) return a;
  if (a === b) return a;
  return 'approximate';
}

function mergeToolOutcomeCoverage(
  a: TraceQualityToolOutcomeCoverage | undefined,
  b: TraceQualityToolOutcomeCoverage | undefined,
): TraceQualityToolOutcomeCoverage {
  if (!a || a === 'not_applicable') return b ?? 'not_applicable';
  if (!b || b === 'not_applicable') return a;
  if (a === b) return a;
  return 'partial';
}

function mergeCoverage(traces: readonly ProjectedTraceQualityTrace[]): TraceQualityCoverage {
  const merged: TraceQualityCoverage = {};
  const confidenceRank: Record<string, number> = { high: 3, medium: 2, low: 1, unknown: 0 };
  let lowestConfidence: string | null = null;
  let source: string | undefined;

  for (const trace of traces) {
    let coverage: TraceQualityCoverage;
    try {
      coverage = JSON.parse(trace.coverage_json) as TraceQualityCoverage;
    } catch {
      coverage = {};
    }
    for (const [key, value] of Object.entries(coverage)) {
      if (
        key === 'projection_confidence'
        || key === 'projection_source'
        || key === 'usage_coverage'
        || key === 'cost_coverage'
        || key === 'cost_provenance'
        || key === 'timestamp_coverage'
        || key === 'tool_outcome_coverage'
      ) continue;
      if (value === true) merged[key] = true;
      else if (merged[key] === undefined) merged[key] = value;
    }
    merged.usage_coverage = mergeUsageCoverage(merged.usage_coverage, coverage.usage_coverage);
    merged.cost_coverage = mergeCostCoverage(merged.cost_coverage, coverage.cost_coverage);
    merged.cost_provenance = mergeCostProvenance(merged.cost_provenance, coverage.cost_provenance);
    merged.timestamp_coverage = mergeTimestampCoverage(merged.timestamp_coverage, coverage.timestamp_coverage);
    merged.tool_outcome_coverage = mergeToolOutcomeCoverage(merged.tool_outcome_coverage, coverage.tool_outcome_coverage);
    source ??= coverage.projection_source;
    const conf = coverage.projection_confidence ?? 'unknown';
    if (lowestConfidence === null || (confidenceRank[conf] ?? 0) < (confidenceRank[lowestConfidence] ?? 0)) {
      lowestConfidence = conf;
    }
  }
  if (source) merged.projection_source = source;
  merged.projection_confidence = (lowestConfidence ?? 'unknown') as TraceQualityCoverage['projection_confidence'];
  return merged;
}

/**
 * v1 quality scalar — a transparent, deterministic proxy, NOT a real eval.
 * It blends outcome success (1 − error rate) with telemetry fidelity (coverage
 * breadth × projection confidence). Meaningful evaluation depth is deferred to
 * the export layer (Langfuse / medallion's fluency KPI); this is only a
 * lightweight local signal and the export contract. Range [0, 1].
 */
function computeQualityScalar(
  observationCount: number,
  errorCount: number,
  coverage: TraceQualityCoverage,
): { score: number | null; grade: string | null } {
  if (observationCount === 0) return { score: null, grade: null };

  const successRate = 1 - errorCount / observationCount;
  const confidence = coverage.projection_confidence ?? 'unknown';
  const confidenceWeight = CONFIDENCE_WEIGHT[confidence] ?? 0.6;
  const signalFlags = [
    coverage.has_token_usage === true,
    coverage.has_cost === true,
    coverage.has_tool_details === true,
    coverage.has_parent_child_structure === true,
    coverage.has_full_transcript === true || coverage.has_raw_input === true || coverage.has_raw_output === true,
  ];
  const coverageScore = signalFlags.filter(Boolean).length / signalFlags.length;
  const fidelity = confidenceWeight * (0.5 + 0.5 * coverageScore);
  const score = Math.round(successRate * fidelity * 1000) / 1000;
  const grade = score >= 0.9 ? 'A' : score >= 0.75 ? 'B' : score >= 0.6 ? 'C' : score >= 0.4 ? 'D' : 'F';
  return { score, grade };
}

function isError(observation: ProjectedTraceQualityObservation): boolean {
  return observation.severity === 'error' || observation.status === 'error';
}

/** The event columns the summary reads; everything else on the row is detail. */
type EventRollupSource = Pick<
  EventProjectionSource,
  | 'tokens_in' | 'tokens_out' | 'cache_read_tokens' | 'cache_write_tokens' | 'cost_usd' | 'cost_source'
  | 'duration_ms' | 'status' | 'model' | 'event_type' | 'tool_name' | 'client_timestamp' | 'created_at' | 'metadata'
>;

interface SessionMetadata {
  agentType: string | null;
  project: string | null;
  browsingSession: { started_at: string | null; ended_at: string | null; fidelity?: string | null } | null;
}

interface MeasureRollup {
  count: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latency: number;
  errorCount: number;
  primaryModel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  coverage: TraceQualityCoverage;
}

/**
 * Roll up usage from the session's events. Events are the authoritative usage
 * source: `projectTraceQuality` structures detail from turns/items for Codex/
 * Claude sessions and ignores `input.events`, but those item observations carry
 * zero token/cost — the real usage lives on the event rows. So whenever a
 * session has events, the summary measures and coverage come from them (this
 * also makes the full derive agree with the O(1) incremental event path).
 */
function rollupFromEvents(events: readonly EventRollupSource[]): MeasureRollup {
  const rollup: MeasureRollup = {
    count: events.length,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latency: 0, errorCount: 0,
    primaryModel: null, startedAt: null, endedAt: null, coverage: coverageForEvents(events),
  };
  const modelCounts = new Map<string, number>();
  for (const event of events) {
    rollup.tokensIn += event.tokens_in;
    rollup.tokensOut += event.tokens_out;
    rollup.cacheRead += event.cache_read_tokens;
    rollup.cacheWrite += event.cache_write_tokens;
    rollup.cost += event.cost_usd ?? 0;
    rollup.latency += event.duration_ms ?? 0;
    if (event.status === 'error') rollup.errorCount += 1;
    if (event.model) modelCounts.set(event.model, (modelCounts.get(event.model) ?? 0) + 1);
    const tsCoverage = classifyEventTimestampCoverage(event);
    const ts = tsCoverage === 'unavailable' ? null : (event.client_timestamp ?? event.created_at);
    if (ts && (rollup.startedAt === null || ts < rollup.startedAt)) rollup.startedAt = ts;
    if (ts && (rollup.endedAt === null || ts > rollup.endedAt)) rollup.endedAt = ts;
  }
  rollup.primaryModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return rollup;
}

/** Fallback rollup for sessions with no events (e.g. Claude JSONL message-sourced). */
function rollupFromObservations(
  observations: readonly ProjectedTraceQualityObservation[],
  traces: readonly ProjectedTraceQualityTrace[],
): MeasureRollup {
  const rollup: MeasureRollup = {
    count: observations.length,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latency: 0, errorCount: 0,
    primaryModel: null, startedAt: null, endedAt: null, coverage: mergeCoverage(traces),
  };
  const modelCounts = new Map<string, number>();
  for (const observation of observations) {
    rollup.tokensIn += observation.tokens_in;
    rollup.tokensOut += observation.tokens_out;
    rollup.cacheRead += observation.cache_read_tokens;
    rollup.cacheWrite += observation.cache_write_tokens;
    rollup.cost += observation.cost_usd ?? 0;
    rollup.latency += observation.duration_ms ?? 0;
    if (isError(observation)) rollup.errorCount += 1;
    if (observation.model) modelCounts.set(observation.model, (modelCounts.get(observation.model) ?? 0) + 1);
    if (observation.started_at && (rollup.startedAt === null || observation.started_at < rollup.startedAt)) rollup.startedAt = observation.started_at;
    const end = observation.ended_at ?? observation.started_at;
    if (end && (rollup.endedAt === null || end > rollup.endedAt)) rollup.endedAt = end;
  }
  rollup.primaryModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return rollup;
}

function presentOrNull(value: string | null | undefined): string | null {
  return value != null && value !== '' ? value : null;
}

/**
 * The session fields an event-sourced summary takes from outside the rollup,
 * with the same precedence as `readTraceQualityProjectionInputForSession`, read
 * one row at a time so the transcript tables stay unread.
 */
function readEventSessionMetadata(db: Database, sessionId: string): SessionMetadata {
  const browsingSession = db.prepare(
    'SELECT agent, project, started_at, ended_at, fidelity FROM browsing_sessions WHERE id = ?',
  ).get(sessionId) as { agent: string; project: string | null; started_at: string | null; ended_at: string | null; fidelity: string | null } | undefined;
  const firstTurnAgent = () => (db.prepare(
    'SELECT agent_type FROM session_turns WHERE session_id = ? ORDER BY COALESCE(started_at, created_at), id LIMIT 1',
  ).get(sessionId) as { agent_type: string } | undefined)?.agent_type;
  const firstEventAgent = () => (db.prepare(
    'SELECT agent_type FROM events WHERE session_id = ? ORDER BY COALESCE(client_timestamp, created_at), id LIMIT 1',
  ).get(sessionId) as { agent_type: string } | undefined)?.agent_type;
  const firstEventProject = () => (db.prepare(
    `SELECT project FROM events WHERE session_id = ? AND project IS NOT NULL AND project <> ''
     ORDER BY COALESCE(client_timestamp, created_at), id LIMIT 1`,
  ).get(sessionId) as { project: string } | undefined)?.project;

  return {
    agentType: presentOrNull(browsingSession?.agent) ?? presentOrNull(firstTurnAgent()) ?? presentOrNull(firstEventAgent()),
    project: presentOrNull(browsingSession?.project) ?? presentOrNull(firstEventProject()),
    browsingSession: browsingSession ?? null,
  };
}

function readSessionItemToolOutcomeCounts(db: Database, sessionId: string): {
  toolCalls: number;
  recordedOutcomes: number;
  unrecordedResults: number;
} {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind IN ('tool_call', 'command_execution') THEN 1 ELSE 0 END), 0) AS tool_calls,
      COALESCE(SUM(CASE
        WHEN kind = 'tool_result'
          AND status IN ('success', 'error')
          AND COALESCE(json_extract(payload_json, '$.outcome'), '') != 'unrecorded'
        THEN 1 ELSE 0 END), 0) AS recorded_outcomes,
      COALESCE(SUM(CASE
        WHEN kind = 'tool_result'
          AND (COALESCE(status, '') NOT IN ('success', 'error')
            OR json_extract(payload_json, '$.outcome') = 'unrecorded')
        THEN 1 ELSE 0 END), 0) AS unrecorded_results
    FROM session_items
    WHERE session_id = ?
  `).get(sessionId) as {
    tool_calls: number;
    recorded_outcomes: number;
    unrecorded_results: number;
  };
  return {
    toolCalls: row.tool_calls,
    recordedOutcomes: row.recorded_outcomes,
    unrecordedResults: row.unrecorded_results,
  };
}

export function deriveSessionTraceSummary(sessionId: string, db: Database = getDb()): SessionTraceSummary {
  const events = db.prepare(`
    SELECT tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, cost_source, duration_ms,
           status, model, event_type, tool_name, client_timestamp, created_at, metadata
    FROM events WHERE session_id = ?
  `).all(sessionId) as EventRollupSource[];
  let rollup: MeasureRollup;
  let metadata: SessionMetadata;
  if (events.length > 0) {
    rollup = rollupFromEvents(events);
    metadata = readEventSessionMetadata(db, sessionId);
    // WHY: When a full-fidelity transcript projection exists alongside events (e.g. Antigravity),
    // preserve transcript coverage without scanning message or item tables.
    if (metadata.browsingSession?.fidelity === 'full') {
      rollup.coverage.has_full_transcript = true;
    }
    const itemToolCounts = readSessionItemToolOutcomeCounts(db, sessionId);
    if (itemToolCounts.toolCalls > 0 || itemToolCounts.recordedOutcomes > 0 || itemToolCounts.unrecordedResults > 0) {
      rollup.coverage.has_tool_details = true;
      rollup.coverage.tool_outcome_coverage = classifyToolOutcomeCounts(itemToolCounts);
    }
  } else {
    const input = readTraceQualityProjectionInputForSession(sessionId);
    const projected = projectTraceQuality(input);
    rollup = rollupFromObservations(projected.observations, projected.traces);
    metadata = { agentType: input.agentType ?? null, project: input.project ?? null, browsingSession: input.browsingSession ?? null };
  }

  const { score, grade } = computeQualityScalar(rollup.count, rollup.errorCount, rollup.coverage);

  return {
    session_id: sessionId,
    agent_type: metadata.agentType,
    project: metadata.project,
    primary_model: rollup.primaryModel,
    started_at: metadata.browsingSession?.started_at ?? rollup.startedAt,
    ended_at: metadata.browsingSession?.ended_at ?? rollup.endedAt,
    observation_count: rollup.count,
    error_count: rollup.errorCount,
    tokens_in: rollup.tokensIn,
    tokens_out: rollup.tokensOut,
    cache_read_tokens: rollup.cacheRead,
    cache_write_tokens: rollup.cacheWrite,
    cost_usd: Math.round(rollup.cost * 1e6) / 1e6,
    latency_ms_total: rollup.latency,
    coverage: rollup.coverage,
    quality_score: score,
    quality_grade: grade,
  };
}

interface EventRowForSummary {
  session_id: string;
  agent_type: string | null;
  project: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  cost_source: string | null;
  duration_ms: number | null;
  status: string | null;
  event_type: string | null;
  tool_name: string | null;
  client_timestamp: string | null;
  created_at: string | null;
  metadata: string | null;
  ts: string | null;
}

/**
 * O(1) incremental summary maintenance for a single ingested event. Used on the
 * live (event-sourced) ingest path, where a full re-derive per event would be
 * O(n^2) over a session. Event-sourced sessions have no session_items, so their
 * coverage is exactly the OR-accumulation of per-event flags (mirrors
 * `coverageForEvents`); the quality scalar is recomputed from the running row.
 * Sessions that carry items/messages are maintained by the session hook instead.
 */
export function bumpSessionTraceSummaryForEvent(eventId: number): void {
  const db = getDb();
  const event = db.prepare(`
    SELECT session_id, agent_type, project, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
           cost_usd, cost_source, duration_ms, status, event_type, tool_name,
           client_timestamp, created_at, metadata,
           COALESCE(client_timestamp, created_at) AS ts
    FROM events WHERE id = ?
  `).get(eventId) as EventRowForSummary | undefined;
  if (!event) return;

  const eventInput: EventCoverageInput = {
    tokens_in: event.tokens_in,
    tokens_out: event.tokens_out,
    cache_read_tokens: event.cache_read_tokens,
    cache_write_tokens: event.cache_write_tokens,
    cost_usd: event.cost_usd,
    cost_source: event.cost_source,
    status: event.status,
    event_type: event.event_type ?? 'unknown',
    tool_name: event.tool_name,
    client_timestamp: event.client_timestamp,
    created_at: event.created_at,
    metadata: event.metadata,
  };
  const eventCov = coverageForEvents([eventInput]);
  const measured = isMeasuredUsageEvent(eventInput);
  const effectiveTs = eventCov.timestamp_coverage === 'unavailable' ? null : event.ts;
  const hasTokens = eventCov.has_token_usage === true;
  const hasCost = eventCov.has_cost === true;
  const hasToolDetails = eventCov.has_tool_details === true;
  const isErr = event.status === 'error' ? 1 : 0;

  db.prepare(`
    INSERT INTO session_trace_summary (
      session_id, trace_id, agent_type, project, primary_model, started_at, ended_at,
      observation_count, error_count, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cost_usd, latency_ms_total,
      coverage_json, quality_score, quality_grade, projection_version, updated_at
    ) VALUES (
      @session_id, @trace_id, @agent_type, @project, @model, @ts, @ts,
      1, @is_err, @tokens_in, @tokens_out,
      @cache_read_tokens, @cache_write_tokens, @cost_usd, @duration,
      @coverage_json, NULL, NULL, @projection_version, datetime('now')
    )
    ON CONFLICT(session_id) DO UPDATE SET
      project = COALESCE(session_trace_summary.project, excluded.project),
      primary_model = COALESCE(session_trace_summary.primary_model, excluded.primary_model),
      started_at = MIN(COALESCE(session_trace_summary.started_at, excluded.started_at), COALESCE(excluded.started_at, session_trace_summary.started_at)),
      ended_at = MAX(COALESCE(session_trace_summary.ended_at, excluded.ended_at), COALESCE(excluded.ended_at, session_trace_summary.ended_at)),
      observation_count = session_trace_summary.observation_count + 1,
      error_count = session_trace_summary.error_count + excluded.error_count,
      tokens_in = session_trace_summary.tokens_in + excluded.tokens_in,
      tokens_out = session_trace_summary.tokens_out + excluded.tokens_out,
      cache_read_tokens = session_trace_summary.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = session_trace_summary.cache_write_tokens + excluded.cache_write_tokens,
      cost_usd = session_trace_summary.cost_usd + excluded.cost_usd,
      latency_ms_total = session_trace_summary.latency_ms_total + excluded.latency_ms_total,
      updated_at = datetime('now')
  `).run({
    session_id: event.session_id,
    trace_id: sessionTraceId(event.session_id),
    agent_type: event.agent_type,
    project: event.project,
    model: event.model,
    ts: effectiveTs,
    is_err: isErr,
    tokens_in: event.tokens_in,
    tokens_out: event.tokens_out,
    cache_read_tokens: event.cache_read_tokens,
    cache_write_tokens: event.cache_write_tokens,
    cost_usd: event.cost_usd ?? 0,
    duration: event.duration_ms ?? 0,
    coverage_json: JSON.stringify(eventCov),
    projection_version: SESSION_TRACE_SUMMARY_VERSION,
  });

  const row = db.prepare(`
    SELECT observation_count, error_count, coverage_json FROM session_trace_summary WHERE session_id = ?
  `).get(event.session_id) as { observation_count: number; error_count: number; coverage_json: string };
  const prior = JSON.parse(row.coverage_json) as TraceQualityCoverage;
  const isFirst = row.observation_count === 1;
  const usageCoverage = isFirst
    ? eventCov.usage_coverage
    : mergeUsageCoverage(prior.usage_coverage, eventCov.usage_coverage);
  const costCoverage = isFirst
    ? eventCov.cost_coverage
    : measured
      ? mergeCostCoverage(prior.cost_coverage, eventCov.cost_coverage)
      : (prior.cost_coverage ?? 'unavailable');
  const costProvenance = isFirst
    ? eventCov.cost_provenance
    : mergeCostProvenance(prior.cost_provenance, eventCov.cost_provenance);
  const timestampCoverage = isFirst
    ? eventCov.timestamp_coverage
    : mergeTimestampCoverage(prior.timestamp_coverage, eventCov.timestamp_coverage);
  const toolOutcomeCoverage = isFirst
    ? eventCov.tool_outcome_coverage
    : mergeToolOutcomeCoverage(prior.tool_outcome_coverage, eventCov.tool_outcome_coverage);
  const mergedHasTokens = prior.has_token_usage === true || hasTokens;
  const mergedHasCost = prior.has_cost === true || hasCost;
  const coverage: TraceQualityCoverage = {
    has_full_transcript: prior.has_full_transcript === true,
    has_token_usage: mergedHasTokens,
    has_cost: mergedHasCost,
    has_tool_details: prior.has_tool_details === true || hasToolDetails,
    usage_coverage: usageCoverage,
    cost_coverage: costCoverage,
    cost_provenance: costProvenance,
    timestamp_coverage: timestampCoverage,
    tool_outcome_coverage: toolOutcomeCoverage,
    projection_source: 'events',
    projection_confidence: mergedHasTokens || mergedHasCost ? 'medium' : 'low',
  };
  const { score, grade } = computeQualityScalar(row.observation_count, row.error_count, coverage);
  db.prepare('UPDATE session_trace_summary SET coverage_json = ?, quality_score = ?, quality_grade = ? WHERE session_id = ?')
    .run(JSON.stringify(coverage), score, grade, event.session_id);
}

function upsertSessionTraceSummary(db: Database, summary: SessionTraceSummary): void {
  db.prepare(`
    INSERT INTO session_trace_summary (
      session_id, trace_id, agent_type, project, primary_model, started_at, ended_at,
      observation_count, error_count, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cost_usd, latency_ms_total,
      coverage_json, quality_score, quality_grade, projection_version, updated_at
    ) VALUES (
      @session_id, @trace_id, @agent_type, @project, @primary_model, @started_at, @ended_at,
      @observation_count, @error_count, @tokens_in, @tokens_out,
      @cache_read_tokens, @cache_write_tokens, @cost_usd, @latency_ms_total,
      @coverage_json, @quality_score, @quality_grade, @projection_version, datetime('now')
    )
    ON CONFLICT(session_id) DO UPDATE SET
      trace_id = excluded.trace_id,
      agent_type = excluded.agent_type,
      project = excluded.project,
      primary_model = excluded.primary_model,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      observation_count = excluded.observation_count,
      error_count = excluded.error_count,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cost_usd = excluded.cost_usd,
      latency_ms_total = excluded.latency_ms_total,
      coverage_json = excluded.coverage_json,
      quality_score = excluded.quality_score,
      quality_grade = excluded.quality_grade,
      projection_version = excluded.projection_version,
      updated_at = datetime('now')
  `).run({
    session_id: summary.session_id,
    trace_id: sessionTraceId(summary.session_id),
    agent_type: summary.agent_type,
    project: summary.project,
    primary_model: summary.primary_model,
    started_at: summary.started_at,
    ended_at: summary.ended_at,
    observation_count: summary.observation_count,
    error_count: summary.error_count,
    tokens_in: summary.tokens_in,
    tokens_out: summary.tokens_out,
    cache_read_tokens: summary.cache_read_tokens,
    cache_write_tokens: summary.cache_write_tokens,
    cost_usd: summary.cost_usd,
    latency_ms_total: summary.latency_ms_total,
    coverage_json: JSON.stringify(summary.coverage),
    quality_score: summary.quality_score,
    quality_grade: summary.quality_grade,
    projection_version: SESSION_TRACE_SUMMARY_VERSION,
  });
}

export function maintainSessionTraceSummary(sessionId: string, db: Database = getDb()): void {
  upsertSessionTraceSummary(db, deriveSessionTraceSummary(sessionId, db));
}

/**
 * Run the one-time backfill at startup if the summary table is empty but
 * sessions exist (i.e. an existing DB upgrading into the reframe). Self-healing
 * and idempotent: once populated it is a single cheap probe.
 */
export function ensureSessionTraceSummaryBackfill(): number {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM session_trace_summary').get() as { c: number }).c;
  const incomplete = (db.prepare(
    `SELECT COUNT(*) AS c FROM session_trace_summary
     WHERE projection_version IS NOT ? OR trace_id IS NULL`,
  ).get(SESSION_TRACE_SUMMARY_VERSION) as { c: number }).c;
  if (total > 0 && incomplete === 0) return 0;

  const hasSessions =
    db.prepare('SELECT 1 FROM browsing_sessions LIMIT 1').get() ?? db.prepare('SELECT 1 FROM events LIMIT 1').get();
  if (!hasSessions) return 0;
  return backfillSessionTraceSummaries(db);
}

/** One-shot/idempotent backfill of every session's summary. */
export function backfillSessionTraceSummaries(db: Database = getDb()): number {
  const sessionIds = new Set<string>();
  for (const row of db.prepare('SELECT id FROM browsing_sessions').all() as Array<{ id: string }>) {
    sessionIds.add(row.id);
  }
  for (const row of db.prepare('SELECT DISTINCT session_id FROM events').all() as Array<{ session_id: string }>) {
    sessionIds.add(row.session_id);
  }
  let count = 0;
  for (const sessionId of sessionIds) {
    upsertSessionTraceSummary(db, deriveSessionTraceSummary(sessionId));
    count += 1;
  }
  return count;
}
