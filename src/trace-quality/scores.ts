import { getDb } from '../db/connection.js';
import type { TraceQualityScore } from '../api/v2/types.js';
import type {
  TraceQualityScoreRow,
  TraceQualityScoreSource,
  TraceQualityScoreTargetType,
  TraceQualityScoreValueType,
} from './types.js';

const USER_SCORE_TARGET_TYPES = [
  'session',
  'trace',
  'observation',
  'message',
  'event',
  'session_item',
] as const;

const USER_SCORE_VALUE_TYPES = ['numeric', 'categorical', 'boolean', 'text'] as const;
const USER_SCORE_SOURCES = ['human', 'code_evaluator', 'llm_judge', 'api'] as const;
const CODE_EVALUATOR_NAMES = [
  'tool_success',
  'high_cost_session',
  'missing_pricing',
  'low_fidelity_trace',
  'rate_limit_or_error',
] as const;

type UserScoreTargetType = typeof USER_SCORE_TARGET_TYPES[number];
type UserScoreValueType = typeof USER_SCORE_VALUE_TYPES[number];
type UserScoreSource = typeof USER_SCORE_SOURCES[number];

export interface TraceQualityScoreMutationInput {
  target_type: string;
  target_id: string;
  name: string;
  value_type: string;
  value?: unknown;
  numeric_value?: unknown;
  categorical_value?: unknown;
  boolean_value?: unknown;
  text_value?: unknown;
  source?: string;
  evaluator_name?: unknown;
  comment?: unknown;
  metadata?: unknown;
  metadata_json?: unknown;
}

export type TraceQualityScorePatchInput = Partial<TraceQualityScoreMutationInput>;

interface NormalizedScoreInput {
  target_type: UserScoreTargetType;
  target_id: string;
  name: string;
  value_type: UserScoreValueType;
  numeric_value: number | null;
  categorical_value: string | null;
  boolean_value: number | null;
  text_value: string | null;
  source: UserScoreSource;
  evaluator_name: string | null;
  comment: string | null;
  metadata_json: string;
}

interface ValueColumns {
  numeric_value: number | null;
  categorical_value: string | null;
  boolean_value: number | null;
  text_value: string | null;
}

export interface TraceQualityCodeEvaluatorOptions {
  traceId?: string;
  sessionId?: string;
  highCostUsdThreshold?: number;
}

export interface TraceQualityCodeEvaluatorSummary {
  deleted: number;
  created: number;
  scores: TraceQualityScore[];
}

class TraceQualityScoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceQualityScoreValidationError';
  }
}

class TraceQualityScoreNotFoundError extends Error {
  constructor(message = 'Score not found') {
    super(message);
    this.name = 'TraceQualityScoreNotFoundError';
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  return {};
}

function mapScoreValue(row: TraceQualityScoreRow): TraceQualityScore['value'] {
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

function mapScore(row: TraceQualityScoreRow): TraceQualityScore {
  return {
    ...row,
    metadata: parseJsonRecord(row.metadata_json),
    value: mapScoreValue(row),
  };
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TraceQualityScoreValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new TraceQualityScoreValidationError(`${field} must not be empty`);
  }
  return normalized;
}

function normalizeNullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new TraceQualityScoreValidationError(`${field} must be a string`);
  }
  return value;
}

function normalizeTargetType(value: unknown): UserScoreTargetType {
  const targetType = normalizeRequiredString(value, 'target_type');
  if (!USER_SCORE_TARGET_TYPES.includes(targetType as UserScoreTargetType)) {
    throw new TraceQualityScoreValidationError(`Unsupported score target_type: ${targetType}`);
  }
  return targetType as UserScoreTargetType;
}

function normalizeValueType(value: unknown): UserScoreValueType {
  const valueType = normalizeRequiredString(value, 'value_type');
  if (!USER_SCORE_VALUE_TYPES.includes(valueType as UserScoreValueType)) {
    throw new TraceQualityScoreValidationError(`Unsupported score value_type: ${valueType}`);
  }
  return valueType as UserScoreValueType;
}

function normalizeSource(value: unknown): UserScoreSource {
  const source = value == null ? 'human' : normalizeRequiredString(value, 'source');
  if (!USER_SCORE_SOURCES.includes(source as UserScoreSource)) {
    throw new TraceQualityScoreValidationError(`Unsupported score source: ${source}`);
  }
  return source as UserScoreSource;
}

function normalizeMetadataJson(metadata: unknown, metadataJson: unknown, fallback = '{}'): string {
  if (metadata !== undefined) {
    if (metadata == null) return '{}';
    if (!isRecord(metadata)) {
      throw new TraceQualityScoreValidationError('metadata must be an object');
    }
    return JSON.stringify(metadata);
  }

  if (metadataJson !== undefined) {
    if (typeof metadataJson !== 'string') {
      throw new TraceQualityScoreValidationError('metadata_json must be a JSON object string');
    }
    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      if (!isRecord(parsed)) {
        throw new TraceQualityScoreValidationError('metadata_json must be a JSON object string');
      }
      return JSON.stringify(parsed);
    } catch (err) {
      if (err instanceof TraceQualityScoreValidationError) throw err;
      throw new TraceQualityScoreValidationError('metadata_json must be valid JSON');
    }
  }

  return fallback;
}

function normalizeNumericScoreValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TraceQualityScoreValidationError('numeric score value must be a finite number');
  }
  return value;
}

function normalizeCategoricalScoreValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TraceQualityScoreValidationError('categorical score value must be a non-empty string');
  }
  return value.trim();
}

function normalizeBooleanScoreValue(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  throw new TraceQualityScoreValidationError('boolean score value must be a boolean');
}

function normalizeTextScoreValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TraceQualityScoreValidationError('text score value must be a string');
  }
  return value;
}

function valueFieldForType(valueType: UserScoreValueType): keyof ValueColumns {
  switch (valueType) {
    case 'numeric':
      return 'numeric_value';
    case 'categorical':
      return 'categorical_value';
    case 'boolean':
      return 'boolean_value';
    case 'text':
      return 'text_value';
  }
}

function normalizeValueColumns(
  input: Record<string, unknown>,
  valueType: UserScoreValueType,
  existing?: ValueColumns,
  valueTypeChanged = false,
): ValueColumns {
  const valueKeys = ['numeric_value', 'categorical_value', 'boolean_value', 'text_value'] as const;
  const suppliedTypedKeys = valueKeys.filter(key => hasOwn(input, key) && input[key] != null);
  const hasGenericValue = hasOwn(input, 'value') && input.value != null;

  if (hasGenericValue && suppliedTypedKeys.length > 0) {
    throw new TraceQualityScoreValidationError('Use either value or a typed score value column, not both');
  }

  if (!hasGenericValue && suppliedTypedKeys.length === 0) {
    if (existing && !valueTypeChanged) return existing;
    throw new TraceQualityScoreValidationError(`A ${valueType} score value is required`);
  }

  if (suppliedTypedKeys.length > 1) {
    throw new TraceQualityScoreValidationError('Only one score value column may be supplied');
  }

  const expectedTypedKey = valueFieldForType(valueType);
  const suppliedKey = hasGenericValue ? 'value' : suppliedTypedKeys[0];
  if (suppliedKey !== 'value' && suppliedKey !== expectedTypedKey) {
    throw new TraceQualityScoreValidationError(`${String(suppliedKey)} does not match value_type ${valueType}`);
  }

  const rawValue = hasGenericValue ? input.value : input[expectedTypedKey];
  const columns: ValueColumns = {
    numeric_value: null,
    categorical_value: null,
    boolean_value: null,
    text_value: null,
  };

  switch (valueType) {
    case 'numeric':
      columns.numeric_value = normalizeNumericScoreValue(rawValue);
      break;
    case 'categorical':
      columns.categorical_value = normalizeCategoricalScoreValue(rawValue);
      break;
    case 'boolean':
      columns.boolean_value = normalizeBooleanScoreValue(rawValue);
      break;
    case 'text':
      columns.text_value = normalizeTextScoreValue(rawValue);
      break;
  }

  return columns;
}

function scoreTargetExists(targetType: UserScoreTargetType, targetId: string): boolean {
  const db = getDb();
  switch (targetType) {
    case 'trace':
      return Boolean(db.prepare('SELECT 1 FROM trace_quality_traces WHERE id = ?').get(targetId));
    case 'observation':
      return Boolean(db.prepare('SELECT 1 FROM trace_quality_observations WHERE id = ?').get(targetId));
    case 'session':
      return Boolean(db.prepare(`
        SELECT 1
        WHERE EXISTS (SELECT 1 FROM browsing_sessions WHERE id = ?)
           OR EXISTS (SELECT 1 FROM sessions WHERE id = ?)
           OR EXISTS (SELECT 1 FROM trace_quality_traces WHERE session_id = ?)
      `).get(targetId, targetId, targetId));
    case 'message':
      return Boolean(db.prepare('SELECT 1 FROM messages WHERE CAST(id AS TEXT) = ?').get(targetId));
    case 'event':
      return Boolean(db.prepare('SELECT 1 FROM events WHERE CAST(id AS TEXT) = ? OR event_id = ?').get(targetId, targetId));
    case 'session_item':
      return Boolean(db.prepare('SELECT 1 FROM session_items WHERE CAST(id AS TEXT) = ? OR source_item_id = ?').get(targetId, targetId));
  }
}

function normalizeScoreInput(input: Record<string, unknown>, existing?: TraceQualityScoreRow): NormalizedScoreInput {
  const targetType = hasOwn(input, 'target_type')
    ? normalizeTargetType(input.target_type)
    : existing?.target_type as UserScoreTargetType | undefined;
  if (!targetType) throw new TraceQualityScoreValidationError('target_type is required');

  const targetId = hasOwn(input, 'target_id')
    ? normalizeRequiredString(input.target_id, 'target_id')
    : existing?.target_id;
  if (!targetId) throw new TraceQualityScoreValidationError('target_id is required');

  const name = hasOwn(input, 'name')
    ? normalizeRequiredString(input.name, 'name')
    : existing?.name;
  if (!name) throw new TraceQualityScoreValidationError('name is required');

  const valueType = hasOwn(input, 'value_type')
    ? normalizeValueType(input.value_type)
    : existing?.value_type as UserScoreValueType | undefined;
  if (!valueType) throw new TraceQualityScoreValidationError('value_type is required');

  const source = hasOwn(input, 'source')
    ? normalizeSource(input.source)
    : (existing?.source as UserScoreSource | undefined) ?? 'human';

  if (!scoreTargetExists(targetType, targetId)) {
    throw new TraceQualityScoreValidationError(`Score target not found: ${targetType}:${targetId}`);
  }

  const existingValueColumns = existing
    ? {
        numeric_value: existing.numeric_value,
        categorical_value: existing.categorical_value,
        boolean_value: existing.boolean_value,
        text_value: existing.text_value,
      }
    : undefined;
  const valueColumns = normalizeValueColumns(input, valueType, existingValueColumns, Boolean(existing && valueType !== existing.value_type));

  return {
    target_type: targetType,
    target_id: targetId,
    name,
    value_type: valueType,
    ...valueColumns,
    source,
    evaluator_name: hasOwn(input, 'evaluator_name')
      ? normalizeNullableString(input.evaluator_name, 'evaluator_name')
      : existing?.evaluator_name ?? null,
    comment: hasOwn(input, 'comment')
      ? normalizeNullableString(input.comment, 'comment')
      : existing?.comment ?? null,
    metadata_json: normalizeMetadataJson(input.metadata, input.metadata_json, existing?.metadata_json ?? '{}'),
  };
}

function getScoreRow(id: number): TraceQualityScoreRow | null {
  const row = getDb().prepare('SELECT * FROM trace_quality_scores WHERE id = ?').get(id) as TraceQualityScoreRow | undefined;
  return row ?? null;
}

function getScoreRowOrThrow(id: number): TraceQualityScoreRow {
  const row = getScoreRow(id);
  if (!row) throw new TraceQualityScoreNotFoundError();
  return row;
}

function validateScoreId(id: number): number {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TraceQualityScoreValidationError('Score id must be a positive integer');
  }
  return id;
}

function insertScore(input: NormalizedScoreInput): TraceQualityScore {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO trace_quality_scores (
      target_type, target_id, name, value_type, numeric_value, categorical_value,
      boolean_value, text_value, source, evaluator_name, comment, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.target_type,
    input.target_id,
    input.name,
    input.value_type,
    input.numeric_value,
    input.categorical_value,
    input.boolean_value,
    input.text_value,
    input.source,
    input.evaluator_name,
    input.comment,
    input.metadata_json,
  );
  return mapScore(getScoreRowOrThrow(Number(result.lastInsertRowid)));
}

export function createTraceQualityScore(input: unknown): TraceQualityScore {
  if (!isRecord(input)) {
    throw new TraceQualityScoreValidationError('Score payload must be an object');
  }
  return insertScore(normalizeScoreInput(input));
}

export function updateTraceQualityScore(id: number, input: unknown): TraceQualityScore {
  validateScoreId(id);
  if (!isRecord(input)) {
    throw new TraceQualityScoreValidationError('Score patch payload must be an object');
  }

  const existing = getScoreRowOrThrow(id);
  const normalized = normalizeScoreInput(input, existing);
  getDb().prepare(`
    UPDATE trace_quality_scores
    SET target_type = ?,
        target_id = ?,
        name = ?,
        value_type = ?,
        numeric_value = ?,
        categorical_value = ?,
        boolean_value = ?,
        text_value = ?,
        source = ?,
        evaluator_name = ?,
        comment = ?,
        metadata_json = ?
    WHERE id = ?
  `).run(
    normalized.target_type,
    normalized.target_id,
    normalized.name,
    normalized.value_type,
    normalized.numeric_value,
    normalized.categorical_value,
    normalized.boolean_value,
    normalized.text_value,
    normalized.source,
    normalized.evaluator_name,
    normalized.comment,
    normalized.metadata_json,
    id,
  );

  return mapScore(getScoreRowOrThrow(id));
}

export function deleteTraceQualityScore(id: number): boolean {
  validateScoreId(id);
  const result = getDb().prepare('DELETE FROM trace_quality_scores WHERE id = ?').run(id);
  return result.changes > 0;
}

function traceScope(alias: string, options: TraceQualityCodeEvaluatorOptions): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (options.traceId) {
    conditions.push(`${alias}.id = ?`);
    values.push(options.traceId);
  }
  if (options.sessionId) {
    conditions.push(`${alias}.session_id = ?`);
    values.push(options.sessionId);
  }
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

function evaluatorNamePlaceholders(): string {
  return CODE_EVALUATOR_NAMES.map(() => '?').join(', ');
}

function scoreInput(
  targetType: UserScoreTargetType,
  targetId: string,
  name: typeof CODE_EVALUATOR_NAMES[number],
  value: boolean,
  metadata: Record<string, unknown>,
  comment: string,
): NormalizedScoreInput {
  return normalizeScoreInput({
    target_type: targetType,
    target_id: targetId,
    name,
    value_type: 'boolean',
    value,
    source: 'code_evaluator',
    evaluator_name: name,
    comment,
    metadata,
  });
}

export function runTraceQualityCodeEvaluators(options: TraceQualityCodeEvaluatorOptions = {}): TraceQualityCodeEvaluatorSummary {
  const db = getDb();
  const highCostUsdThreshold = options.highCostUsdThreshold ?? 1;
  if (!Number.isFinite(highCostUsdThreshold) || highCostUsdThreshold < 0) {
    throw new TraceQualityScoreValidationError('highCostUsdThreshold must be a non-negative number');
  }

  const execute = db.transaction((): TraceQualityCodeEvaluatorSummary => {
    const deleteTraceScope = traceScope('td', options);
    const deleteValues: unknown[] = [...CODE_EVALUATOR_NAMES];
    deleteValues.push(...deleteTraceScope.values, ...deleteTraceScope.values, ...deleteTraceScope.values);
    const deleteResult = db.prepare(`
      DELETE FROM trace_quality_scores
      WHERE source = 'code_evaluator'
        AND evaluator_name IN (${evaluatorNamePlaceholders()})
        AND (
          (target_type = 'trace' AND target_id IN (
            SELECT td.id FROM trace_quality_traces td ${deleteTraceScope.where}
          ))
          OR (target_type = 'observation' AND target_id IN (
            SELECT od.id
            FROM trace_quality_observations od
            WHERE od.trace_id IN (SELECT td.id FROM trace_quality_traces td ${deleteTraceScope.where})
          ))
          OR (target_type = 'session' AND target_id IN (
            SELECT DISTINCT td.session_id FROM trace_quality_traces td ${deleteTraceScope.where}
          ))
        )
    `).run(...deleteValues);

    const scoped = traceScope('ts', options);
    const traceSubquery = `SELECT ts.id FROM trace_quality_traces ts ${scoped.where}`;
    const scores: TraceQualityScore[] = [];

    const toolRows = db.prepare(`
      SELECT id, status, severity, tool_name
      FROM trace_quality_observations
      WHERE observation_type = 'tool'
        AND trace_id IN (${traceSubquery})
      ORDER BY datetime(COALESCE(started_at, created_at)), id
    `).all(...scoped.values) as Array<{
      id: string;
      status: string | null;
      severity: string | null;
      tool_name: string | null;
    }>;

    for (const row of toolRows) {
      const ok = row.status !== 'error' && row.status !== 'timeout' && row.severity !== 'error' && row.severity !== 'critical';
      scores.push(insertScore(scoreInput(
        'observation',
        row.id,
        'tool_success',
        ok,
        { status: row.status, severity: row.severity, tool_name: row.tool_name },
        ok ? 'Tool observation completed successfully.' : 'Tool observation reported an error.',
      )));
    }

    const highCostRows = db.prepare(`
      SELECT t.session_id, COALESCE(SUM(o.cost_usd), 0) AS total_cost_usd
      FROM trace_quality_traces t
      JOIN trace_quality_observations o ON o.trace_id = t.id
      WHERE t.id IN (${traceSubquery})
        AND o.cost_usd IS NOT NULL
      GROUP BY t.session_id
      HAVING total_cost_usd >= ?
      ORDER BY total_cost_usd DESC, t.session_id
    `).all(...scoped.values, highCostUsdThreshold) as Array<{ session_id: string; total_cost_usd: number }>;

    for (const row of highCostRows) {
      scores.push(insertScore(scoreInput(
        'session',
        row.session_id,
        'high_cost_session',
        true,
        { total_cost_usd: row.total_cost_usd, threshold_usd: highCostUsdThreshold },
        `Session cost ${row.total_cost_usd} is at or above ${highCostUsdThreshold}.`,
      )));
    }

    const missingPricingRows = db.prepare(`
      SELECT id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, model
      FROM trace_quality_observations
      WHERE trace_id IN (${traceSubquery})
        AND cost_usd IS NULL
        AND (
          COALESCE(tokens_in, 0) > 0
          OR COALESCE(tokens_out, 0) > 0
          OR COALESCE(cache_read_tokens, 0) > 0
          OR COALESCE(cache_write_tokens, 0) > 0
        )
      ORDER BY datetime(COALESCE(started_at, created_at)), id
    `).all(...scoped.values) as Array<{
      id: string;
      tokens_in: number;
      tokens_out: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      model: string | null;
    }>;

    for (const row of missingPricingRows) {
      scores.push(insertScore(scoreInput(
        'observation',
        row.id,
        'missing_pricing',
        true,
        {
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
          cache_read_tokens: row.cache_read_tokens,
          cache_write_tokens: row.cache_write_tokens,
          model: row.model,
        },
        'Observation has token usage but no stored cost.',
      )));
    }

    const lowFidelityRows = db.prepare(`
      SELECT id, coverage_json
      FROM trace_quality_traces
      WHERE id IN (${traceSubquery})
        AND (
          COALESCE(json_extract(coverage_json, '$.projection_confidence'), 'unknown') IN ('low', 'unknown')
          OR COALESCE(json_extract(coverage_json, '$.has_full_transcript'), 0) = 0
        )
      ORDER BY datetime(COALESCE(started_at, created_at)), id
    `).all(...scoped.values) as Array<{ id: string; coverage_json: string }>;

    for (const row of lowFidelityRows) {
      scores.push(insertScore(scoreInput(
        'trace',
        row.id,
        'low_fidelity_trace',
        true,
        parseJsonRecord(row.coverage_json),
        'Trace was projected from partial or low-confidence source data.',
      )));
    }

    const errorRows = db.prepare(`
      SELECT id, status, severity, status_message, metadata_json
      FROM trace_quality_observations
      WHERE trace_id IN (${traceSubquery})
        AND (
          status IN ('error', 'timeout')
          OR severity IN ('error', 'critical')
          OR lower(COALESCE(status_message, '') || ' ' || COALESCE(metadata_json, '{}')) LIKE '%rate limit%'
          OR lower(COALESCE(status_message, '') || ' ' || COALESCE(metadata_json, '{}')) LIKE '%429%'
        )
      ORDER BY datetime(COALESCE(started_at, created_at)), id
    `).all(...scoped.values) as Array<{
      id: string;
      status: string | null;
      severity: string | null;
      status_message: string | null;
      metadata_json: string;
    }>;

    for (const row of errorRows) {
      scores.push(insertScore(scoreInput(
        'observation',
        row.id,
        'rate_limit_or_error',
        true,
        {
          status: row.status,
          severity: row.severity,
          status_message: row.status_message,
          metadata: parseJsonRecord(row.metadata_json),
        },
        'Observation reported an error, timeout, or rate-limit signal.',
      )));
    }

    return {
      deleted: deleteResult.changes,
      created: scores.length,
      scores,
    };
  });

  return execute();
}

export function isTraceQualityScoreMutationError(err: unknown): err is TraceQualityScoreValidationError | TraceQualityScoreNotFoundError {
  return err instanceof TraceQualityScoreValidationError || err instanceof TraceQualityScoreNotFoundError;
}

export function isTraceQualityScoreNotFoundError(err: unknown): err is TraceQualityScoreNotFoundError {
  return err instanceof TraceQualityScoreNotFoundError;
}

export type TraceQualityMutableScoreTargetType = TraceQualityScoreTargetType & UserScoreTargetType;
export type TraceQualityMutableScoreValueType = TraceQualityScoreValueType & UserScoreValueType;
export type TraceQualityMutableScoreSource = TraceQualityScoreSource & UserScoreSource;
