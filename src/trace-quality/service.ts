import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { readTraceQualityProjectionInputForSession } from './source-readers.js';
import {
  projectTraceQuality,
  TRACE_QUALITY_PROJECTION_VERSION,
  type EventProjectionSource,
  type ProjectedTraceQualityObservation,
  type ProjectedTraceQualityTrace,
  type TraceQualityProjectionInput,
  type TraceQualityProjectionResult,
} from './projection.js';

export type TraceQualitySourceRef =
  | { kind: 'event'; eventId: number }
  | { kind: 'session'; sessionId: string };

export interface ProjectTraceQualityOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface BackfillTraceQualityOptions extends ProjectTraceQualityOptions {
  source: 'events' | 'sessions' | 'all';
  sessionId?: string;
  from?: string;
  to?: string;
}

export interface TraceQualityWriteSummary {
  sourcesScanned: number;
  tracesCreated: number;
  tracesUpdated: number;
  observationsCreated: number;
  observationsUpdated: number;
  skippedUnchanged: number;
  warnings: string[];
  dryRun: boolean;
}

interface SourceScope {
  sourceTable: string;
  sourceId: string;
}

interface ProjectedSource {
  scope: SourceScope;
  projection: TraceQualityProjectionResult;
}

function emptySummary(dryRun = false): TraceQualityWriteSummary {
  return {
    sourcesScanned: 0,
    tracesCreated: 0,
    tracesUpdated: 0,
    observationsCreated: 0,
    observationsUpdated: 0,
    skippedUnchanged: 0,
    warnings: [],
    dryRun,
  };
}

function addSummary(target: TraceQualityWriteSummary, next: TraceQualityWriteSummary): void {
  target.sourcesScanned += next.sourcesScanned;
  target.tracesCreated += next.tracesCreated;
  target.tracesUpdated += next.tracesUpdated;
  target.observationsCreated += next.observationsCreated;
  target.observationsUpdated += next.observationsUpdated;
  target.skippedUnchanged += next.skippedUnchanged;
  target.warnings.push(...next.warnings);
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function addDaysToDateString(date: string, days: number): string | null {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function appendBackfillDateRangeConditions(
  conditions: string[],
  values: unknown[],
  column: string,
  from: string | undefined,
  to: string | undefined,
): void {
  if (from) {
    conditions.push(`datetime(${column}) >= datetime(?)`);
    values.push(from);
  }
  if (to) {
    const nextDay = /^\d{4}-\d{2}-\d{2}$/.test(to) ? addDaysToDateString(to, 1) : null;
    if (nextDay) {
      conditions.push(`datetime(${column}) < datetime(?)`);
      values.push(nextDay);
    } else {
      conditions.push(`datetime(${column}) <= datetime(?)`);
      values.push(to);
    }
  }
}

function getJsonMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function projectedPayloadHash(projection: TraceQualityProjectionResult): string {
  return stableHash({
    version: TRACE_QUALITY_PROJECTION_VERSION,
    traces: projection.traces,
    observations: projection.observations,
  });
}

function existingSourcePayloadHash(db: Database.Database, scope: SourceScope): string | null {
  const row = db.prepare(`
    SELECT payload_hash
    FROM trace_quality_projection_state
    WHERE source_table = ? AND source_id = ? AND projection_version = ?
  `).get(scope.sourceTable, scope.sourceId, TRACE_QUALITY_PROJECTION_VERSION) as { payload_hash: string | null } | undefined;

  return row?.payload_hash ?? null;
}

function existingTraceIdsForScope(
  db: Database.Database,
  scope: SourceScope,
  projectedTraceIds: string[],
): string[] {
  const ids = new Set<string>();
  const stateRows = db.prepare(`
    SELECT trace_id
    FROM trace_quality_projection_state
    WHERE source_table = ? AND source_id = ? AND projection_version = ? AND trace_id IS NOT NULL
  `).all(scope.sourceTable, scope.sourceId, TRACE_QUALITY_PROJECTION_VERSION) as Array<{ trace_id: string }>;

  for (const row of stateRows) ids.add(row.trace_id);

  if (scope.sourceTable === 'sessions') {
    const rows = db.prepare(`
      SELECT id
      FROM trace_quality_traces
      WHERE session_id = ?
        AND json_extract(metadata_json, '$.projection_version') = ?
        AND json_extract(metadata_json, '$.source_table') IN ('session_turns', 'browsing_sessions')
    `).all(scope.sourceId, TRACE_QUALITY_PROJECTION_VERSION) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }

  if (projectedTraceIds.length > 0) {
    const rows = db.prepare(`
      SELECT id
      FROM trace_quality_traces
      WHERE id IN (${placeholders(projectedTraceIds)})
    `).all(...projectedTraceIds) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }

  return [...ids];
}

function observationIdsForTraces(db: Database.Database, traceIds: string[]): string[] {
  if (traceIds.length === 0) return [];
  return (db.prepare(`
    SELECT id
    FROM trace_quality_observations
    WHERE trace_id IN (${placeholders(traceIds)})
  `).all(...traceIds) as Array<{ id: string }>).map(row => row.id);
}

function deleteExistingProjectionRows(
  db: Database.Database,
  scope: SourceScope,
  traceIds: string[],
): { traceCount: number; observationCount: number } {
  const observationIds = observationIdsForTraces(db, traceIds);

  db.prepare(`
    DELETE FROM trace_quality_projection_state
    WHERE source_table = ? AND source_id = ? AND projection_version = ?
  `).run(scope.sourceTable, scope.sourceId, TRACE_QUALITY_PROJECTION_VERSION);

  if (traceIds.length > 0) {
    db.prepare(`
      DELETE FROM trace_quality_projection_state
      WHERE trace_id IN (${placeholders(traceIds)})
    `).run(...traceIds);
  }

  if (observationIds.length > 0) {
    db.prepare(`
      DELETE FROM trace_quality_projection_state
      WHERE observation_id IN (${placeholders(observationIds)})
    `).run(...observationIds);
  }

  if (traceIds.length > 0) {
    db.prepare(`
      DELETE FROM trace_quality_traces
      WHERE id IN (${placeholders(traceIds)})
    `).run(...traceIds);
  }

  return {
    traceCount: traceIds.length,
    observationCount: observationIds.length,
  };
}

function insertTrace(db: Database.Database, trace: ProjectedTraceQualityTrace): void {
  db.prepare(`
    INSERT INTO trace_quality_traces (
      id, session_id, browsing_session_id, source_trace_id, agent_type, name, status,
      project, branch, started_at, ended_at, duration_ms, metadata_json, tags_json, coverage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trace.id,
    trace.session_id,
    trace.browsing_session_id,
    trace.source_trace_id,
    trace.agent_type,
    trace.name,
    trace.status,
    trace.project,
    trace.branch,
    trace.started_at,
    trace.ended_at,
    trace.duration_ms,
    trace.metadata_json,
    trace.tags_json,
    trace.coverage_json,
  );
}

function insertObservation(db: Database.Database, observation: ProjectedTraceQualityObservation): void {
  db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, parent_observation_id, session_id, source_kind, source_id, source_item_id,
      observation_type, name, status, status_message, severity, model, tool_name,
      started_at, ended_at, duration_ms, tokens_in, tokens_out, cache_read_tokens,
      cache_write_tokens, cost_usd, input_hash, output_hash, input_summary, output_summary,
      payload_policy, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.id,
    observation.trace_id,
    observation.parent_observation_id,
    observation.session_id,
    observation.source_kind,
    observation.source_id,
    observation.source_item_id,
    observation.observation_type,
    observation.name,
    observation.status,
    observation.status_message,
    observation.severity,
    observation.model,
    observation.tool_name,
    observation.started_at,
    observation.ended_at,
    observation.duration_ms,
    observation.tokens_in,
    observation.tokens_out,
    observation.cache_read_tokens,
    observation.cache_write_tokens,
    observation.cost_usd,
    observation.input_hash,
    observation.output_hash,
    observation.input_summary,
    observation.output_summary,
    observation.payload_policy,
    observation.metadata_json,
  );
}

function upsertProjectionState(db: Database.Database, input: {
  sourceTable: string;
  sourceId: string;
  traceId: string | null;
  observationId: string | null;
  payloadHash: string | null;
  status: 'projected' | 'failed' | 'skipped' | 'stale';
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  db.prepare(`
    INSERT INTO trace_quality_projection_state (
      source_table, source_id, projection_version, trace_id, observation_id,
      payload_hash, status, projected_at, error_message, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(source_table, source_id, projection_version) DO UPDATE SET
      trace_id = excluded.trace_id,
      observation_id = excluded.observation_id,
      payload_hash = excluded.payload_hash,
      status = excluded.status,
      projected_at = excluded.projected_at,
      error_message = excluded.error_message,
      metadata_json = excluded.metadata_json
  `).run(
    input.sourceTable,
    input.sourceId,
    TRACE_QUALITY_PROJECTION_VERSION,
    input.traceId,
    input.observationId,
    input.payloadHash,
    input.status,
    input.errorMessage ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
}

function writeProjectionStateRows(
  db: Database.Database,
  scope: SourceScope,
  projection: TraceQualityProjectionResult,
  payloadHash: string,
): void {
  const firstTrace = projection.traces[0] ?? null;
  const firstObservation = projection.observations[0] ?? null;
  upsertProjectionState(db, {
    sourceTable: scope.sourceTable,
    sourceId: scope.sourceId,
    traceId: firstTrace?.id ?? null,
    observationId: firstObservation?.id ?? null,
    payloadHash,
    status: 'projected',
    metadata: {
      projection_scope: true,
      trace_count: projection.traces.length,
      observation_count: projection.observations.length,
    },
  });

  const seen = new Set<string>([`${scope.sourceTable}:${scope.sourceId}`]);
  for (const trace of projection.traces) {
    const metadata = getJsonMetadata(trace.metadata_json);
    const sourceTable = typeof metadata.source_table === 'string' ? metadata.source_table : 'trace_quality_traces';
    const sourceId = typeof metadata.source_id === 'string' || typeof metadata.source_id === 'number'
      ? String(metadata.source_id)
      : trace.id;
    const key = `${sourceTable}:${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    upsertProjectionState(db, {
      sourceTable,
      sourceId,
      traceId: trace.id,
      observationId: null,
      payloadHash: stableHash(trace),
      status: 'projected',
      metadata: { projection_scope: false },
    });
  }

  for (const observation of projection.observations) {
    if (!observation.source_id) continue;
    const metadata = getJsonMetadata(observation.metadata_json);
    const sourceTable = typeof metadata.source_table === 'string' ? metadata.source_table : observation.source_kind;
    const sourceId = observation.source_id;
    const key = `${sourceTable}:${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    upsertProjectionState(db, {
      sourceTable,
      sourceId,
      traceId: observation.trace_id,
      observationId: observation.id,
      payloadHash: stableHash(observation),
      status: 'projected',
      metadata: { projection_scope: false },
    });
  }
}

function readEventProjectionInput(db: Database.Database, eventId: number): TraceQualityProjectionInput | null {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventProjectionSource | undefined;
  if (!event) return null;
  return {
    sessionId: event.session_id,
    agentType: event.agent_type,
    project: event.project,
    branch: event.branch,
    events: [event],
  };
}

function projectSource(source: TraceQualitySourceRef): ProjectedSource | null {
  const db = getDb();
  if (source.kind === 'event') {
    const input = readEventProjectionInput(db, source.eventId);
    if (!input) return null;
    return {
      scope: { sourceTable: 'events', sourceId: String(source.eventId) },
      projection: projectTraceQuality(input),
    };
  }

  return {
    scope: { sourceTable: 'sessions', sourceId: source.sessionId },
    projection: projectTraceQuality(readTraceQualityProjectionInputForSession(source.sessionId)),
  };
}

function projectTraceQualityForSource(
  source: TraceQualitySourceRef,
  options: ProjectTraceQualityOptions = {},
): TraceQualityWriteSummary {
  const dryRun = options.dryRun === true;
  const summary = emptySummary(dryRun);
  const projected = projectSource(source);
  if (!projected) {
    summary.warnings.push(`No source row found for ${source.kind}`);
    return summary;
  }

  summary.sourcesScanned = 1;
  summary.warnings.push(...projected.projection.warnings);

  const payloadHash = projectedPayloadHash(projected.projection);
  const db = getDb();
  const projectedTraceIds = projected.projection.traces.map(trace => trace.id);
  const existingTraceIds = existingTraceIdsForScope(db, projected.scope, projectedTraceIds);
  const existingHash = existingSourcePayloadHash(db, projected.scope);

  if (!options.force && existingHash === payloadHash) {
    summary.skippedUnchanged = 1;
    return summary;
  }

  const hasExistingProjection = existingTraceIds.length > 0;
  if (hasExistingProjection) {
    summary.tracesUpdated = projected.projection.traces.length;
    summary.observationsUpdated = projected.projection.observations.length;
  } else {
    summary.tracesCreated = projected.projection.traces.length;
    summary.observationsCreated = projected.projection.observations.length;
  }

  if (dryRun) return summary;

  const txn = db.transaction(() => {
    deleteExistingProjectionRows(db, projected.scope, existingTraceIds);
    for (const trace of projected.projection.traces) {
      insertTrace(db, trace);
    }
    for (const observation of projected.projection.observations) {
      insertObservation(db, observation);
    }
    writeProjectionStateRows(db, projected.scope, projected.projection, payloadHash);
  });

  txn();
  return summary;
}

function eventIdsForBackfill(db: Database.Database, options: BackfillTraceQualityOptions): number[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.sessionId) {
    conditions.push('session_id = ?');
    values.push(options.sessionId);
  }
  appendBackfillDateRangeConditions(
    conditions,
    values,
    'COALESCE(client_timestamp, created_at)',
    options.from,
    options.to,
  );

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return (db.prepare(`
    SELECT id
    FROM events
    ${where}
    ORDER BY datetime(COALESCE(client_timestamp, created_at)), id
  `).all(...values) as Array<{ id: number }>).map(row => row.id);
}

function sessionIdsForBackfill(db: Database.Database, options: BackfillTraceQualityOptions): string[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.sessionId) {
    conditions.push('id = ?');
    values.push(options.sessionId);
  }
  appendBackfillDateRangeConditions(
    conditions,
    values,
    'COALESCE(started_at, last_item_at, ended_at)',
    options.from,
    options.to,
  );

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return (db.prepare(`
    SELECT id
    FROM browsing_sessions
    ${where}
    ORDER BY datetime(COALESCE(started_at, last_item_at, ended_at)), id
  `).all(...values) as Array<{ id: string }>).map(row => row.id);
}

export function backfillTraceQuality(options: BackfillTraceQualityOptions): TraceQualityWriteSummary {
  const summary = emptySummary(options.dryRun === true);
  const db = getDb();

  if (options.source === 'events' || options.source === 'all') {
    for (const eventId of eventIdsForBackfill(db, options)) {
      addSummary(summary, projectTraceQualityForSource(
        { kind: 'event', eventId },
        { dryRun: options.dryRun, force: options.force },
      ));
    }
  }

  if (options.source === 'sessions' || options.source === 'all') {
    for (const sessionId of sessionIdsForBackfill(db, options)) {
      addSummary(summary, projectTraceQualityForSource(
        { kind: 'session', sessionId },
        { dryRun: options.dryRun, force: options.force },
      ));
    }
  }

  return summary;
}

export function safelyProjectTraceQualityForEvent(eventId: number, context: string): void {
  try {
    projectTraceQualityForSource({ kind: 'event', eventId });
  } catch (err) {
    console.error(`[trace-quality] Failed to project event ${eventId} after ${context}:`, err);
  }
}

export function safelyProjectTraceQualityForSession(sessionId: string, context: string): void {
  try {
    projectTraceQualityForSource({ kind: 'session', sessionId }, { force: true });
  } catch (err) {
    console.error(`[trace-quality] Failed to project session ${sessionId} after ${context}:`, err);
  }
}
