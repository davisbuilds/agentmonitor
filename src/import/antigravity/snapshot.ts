import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAntigravityTranscript,
  resolveAntigravityTranscriptPaths,
  type AntigravityTranscriptResult,
} from '../../parser/antigravity-transcript.js';
import {
  decodeGeneratorMetadata,
  decodeStepEnvelope,
  decodeStepTimestampMs,
  type GeneratorMetadata,
  type StepEnvelope,
} from './proto.js';
import { isRetryableSqliteError, openReadOnlySqliteWithRetry, type SqliteReadRetryOptions } from './sqlite.js';
import { readAntigravityConversationSummary, type AntigravitySummaryMetadata } from './summary.js';

export type AntigravityTimestampSource =
  | 'generation_created_at'
  | 'planner_message_id'
  | 'planner_provider_message_id'
  | 'unavailable';

export interface AntigravitySnapshotOptions extends SqliteReadRetryOptions {
  includeTranscript?: boolean;
  includeSummary?: boolean;
}

export interface AntigravityStepRecord {
  idx: number;
  step_type: number;
  status: number;
  step_payload: Buffer;
  metadata: Buffer | null;
  timestampMs: number | undefined;
  envelope: StepEnvelope;
}

export interface AntigravityGenRecord {
  idx: number;
  data: Buffer;
  decoded: GeneratorMetadata;
  timestampMs: number | undefined;
  timestampSource: AntigravityTimestampSource;
}

export interface AntigravityConversationSnapshot {
  sessionId: string;
  filePath: string;
  dbPresent: boolean;
  steps: AntigravityStepRecord[];
  generations: AntigravityGenRecord[];
  summary: AntigravitySummaryMetadata | null;
  transcript: AntigravityTranscriptResult | null;
  startedAtIso: string | null;
  latestActivityIso: string | null;
}

interface RawStepRow {
  idx: number;
  step_type: number;
  status: number;
  step_payload: Buffer;
  metadata: Buffer | null;
}

interface RawGenRow {
  idx: number;
  data: Buffer;
}

function addPlannerMatch(
  index: Map<string, Array<number | undefined>>,
  id: string | undefined,
  tsMs: number | undefined,
): void {
  if (!id) return;
  const list = index.get(id);
  if (list) list.push(tsMs);
  else index.set(id, [tsMs]);
}

function uniquePlannerTimestamp(
  index: Map<string, Array<number | undefined>>,
  id: string | undefined,
): number | undefined {
  if (!id) return undefined;
  const matches = index.get(id);
  if (!matches || matches.length !== 1) return undefined;
  return matches[0];
}

function resolveGenerationTimestamp(
  gm: GeneratorMetadata,
  plannerByMessageId: Map<string, Array<number | undefined>>,
  plannerByProviderId: Map<string, Array<number | undefined>>,
): { timestampMs?: number; timestampSource: AntigravityTimestampSource } {
  if (gm.timestampMs !== undefined) {
    return { timestampMs: gm.timestampMs, timestampSource: 'generation_created_at' };
  }
  const byMessageId = uniquePlannerTimestamp(plannerByMessageId, gm.messageId);
  if (byMessageId !== undefined) {
    return { timestampMs: byMessageId, timestampSource: 'planner_message_id' };
  }
  const byProviderId = uniquePlannerTimestamp(plannerByProviderId, gm.providerAssignedMessageId);
  if (byProviderId !== undefined) {
    return { timestampMs: byProviderId, timestampSource: 'planner_provider_message_id' };
  }
  return { timestampSource: 'unavailable' };
}

function loadPreferredTranscript(filePath: string, sessionId: string): AntigravityTranscriptResult | null {
  const { fullPath, compactPath } = resolveAntigravityTranscriptPaths(filePath, sessionId);
  return parseAntigravityTranscript(fullPath, sessionId)
    ?? parseAntigravityTranscript(compactPath, sessionId);
}

function hashOptionalBytes(hash: crypto.Hash, label: string, candidatePath: string): void {
  try {
    const bytes = fs.readFileSync(candidatePath);
    hash.update(label);
    hash.update(bytes);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err;
    }
  }
}

export function hashAntigravityConversation(
  filePath: string,
  options?: AntigravitySnapshotOptions,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  for (const suffix of ['-wal', '-shm']) {
    hashOptionalBytes(hash, suffix, `${filePath}${suffix}`);
  }

  const sessionId = path.basename(filePath, '.db');
  const summary = readAntigravityConversationSummary(filePath, sessionId, {
    retryDelaysMs: options?.retryDelaysMs,
    busyTimeoutMs: options?.busyTimeoutMs,
    throwOnError: false,
  });
  if (summary) {
    hash.update('summary:');
    hash.update(summary.rawSignature);
  }

  const { fullPath, compactPath } = resolveAntigravityTranscriptPaths(filePath, sessionId);
  hashOptionalBytes(hash, 'transcript_full:', fullPath);
  hashOptionalBytes(hash, 'transcript:', compactPath);

  return hash.digest('hex');
}

function readRawSqliteRows(
  filePath: string,
  options?: AntigravitySnapshotOptions,
): { dbPresent: boolean; steps: RawStepRow[]; genRows: RawGenRow[] } {
  if (!fs.existsSync(filePath)) {
    return { dbPresent: false, steps: [], genRows: [] };
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      return { dbPresent: true, steps: [], genRows: [] };
    }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return { dbPresent: false, steps: [], genRows: [] };
    throw err;
  }

  try {
    const rows = openReadOnlySqliteWithRetry(filePath, (db) => {
      const tableRows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('steps', 'gen_metadata')",
      ).all() as Array<{ name: string }>;
      const tables = new Set(tableRows.map((row) => row.name));
      const steps = tables.has('steps')
        ? db.prepare('SELECT idx, step_type, status, step_payload, metadata FROM steps ORDER BY idx').all() as RawStepRow[]
        : [];
      const genRows = tables.has('gen_metadata')
        ? db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as RawGenRow[]
        : [];
      return { steps, genRows };
    }, options);

    if (!rows) return { dbPresent: false, steps: [], genRows: [] };
    return { dbPresent: true, steps: rows.steps, genRows: rows.genRows };
  } catch (err) {
    if (options?.throwOnError === false || !isRetryableSqliteError(err)) {
      return { dbPresent: false, steps: [], genRows: [] };
    }
    throw err;
  }
}

export function readAntigravityConversationSnapshot(
  filePath: string,
  options?: AntigravitySnapshotOptions,
): AntigravityConversationSnapshot {
  const sessionId = path.basename(filePath, '.db');
  const { dbPresent, steps: rawSteps, genRows: rawGens } = readRawSqliteRows(filePath, {
    retryDelaysMs: options?.retryDelaysMs,
    busyTimeoutMs: options?.busyTimeoutMs,
    throwOnError: options?.throwOnError ?? true,
  });

  const plannerByMessageId = new Map<string, Array<number | undefined>>();
  const plannerByProviderId = new Map<string, Array<number | undefined>>();

  const steps: AntigravityStepRecord[] = rawSteps.map((row) => {
    const timestampMs = row.metadata ? decodeStepTimestampMs(row.metadata) : undefined;
    const envelope = decodeStepEnvelope(row.step_payload);
    if (envelope.kind === 'planner_response' && envelope.plannerIds) {
      addPlannerMatch(plannerByMessageId, envelope.plannerIds.messageId, timestampMs);
      addPlannerMatch(plannerByProviderId, envelope.plannerIds.providerAssignedMessageId, timestampMs);
    }
    return {
      idx: row.idx,
      step_type: row.step_type,
      status: row.status,
      step_payload: row.step_payload,
      metadata: row.metadata,
      timestampMs,
      envelope,
    };
  });

  const generations: AntigravityGenRecord[] = rawGens.map((row) => {
    const decoded = decodeGeneratorMetadata(row.data);
    const { timestampMs, timestampSource } = resolveGenerationTimestamp(
      decoded,
      plannerByMessageId,
      plannerByProviderId,
    );
    return {
      idx: row.idx,
      data: row.data,
      decoded,
      timestampMs,
      timestampSource,
    };
  });

  const summary = options?.includeSummary === false
    ? null
    : readAntigravityConversationSummary(filePath, sessionId, options);
  const transcript = options?.includeTranscript === false
    ? null
    : loadPreferredTranscript(filePath, sessionId);

  let minMs: number | undefined;
  let maxMs: number | undefined;
  const recordMs = (ms: number | undefined) => {
    if (ms === undefined || !Number.isFinite(ms)) return;
    if (minMs === undefined || ms < minMs) minMs = ms;
    if (maxMs === undefined || ms > maxMs) maxMs = ms;
  };
  const recordIso = (isoValue: string | null | undefined) => {
    if (!isoValue) return;
    const parsed = Date.parse(isoValue);
    if (Number.isFinite(parsed)) recordMs(parsed);
  };

  for (const step of steps) recordMs(step.timestampMs);
  for (const gen of generations) recordMs(gen.timestampMs);
  if (transcript) {
    recordIso(transcript.startedAt);
    recordIso(transcript.endedAt);
  }

  return {
    sessionId,
    filePath,
    dbPresent,
    steps,
    generations,
    summary,
    transcript,
    startedAtIso: minMs !== undefined ? new Date(minMs).toISOString() : null,
    latestActivityIso: maxMs !== undefined ? new Date(maxMs).toISOString() : null,
  };
}
