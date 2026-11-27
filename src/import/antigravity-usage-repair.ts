import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { markStatsDirty, serializeEventMetadata } from '../db/queries.js';
import { acquireRuntimeOwnership } from '../runtime-ownership.js';
import { maintainSessionTraceSummary } from '../trace-quality/summary.js';
import type { ParsedImportEvent } from './claude-code.js';
import { sameCost } from './codex-reconcile.js';
import {
  antigravitySnapshotToEvents,
  discoverAntigravityLogs,
  generationIdentityMetadataByEventId,
  matchLegacyAntigravityRows,
  reconcileAntigravitySessionLifecycle,
  upsertAntigravityImportState,
  type GenerationIdentityMetadata,
} from './antigravity.js';
import {
  hashAntigravityConversation,
  readAntigravityConversationSnapshot,
  type AntigravityConversationSnapshot,
} from './antigravity/snapshot.js';

export interface AntigravityUsageRepairOptions {
  antigravityDir?: string;
  apply?: boolean;
  excludePatterns?: string[];
  dbPath?: string;
}

export interface AntigravityRepairFailure {
  conversation: string;
  error: string;
}

export type AntigravityUsageRepairReport = {
  apply: boolean;
  files_scanned: number;
  files_unreadable: number;
  sessions_without_source: number;
  sessions_changed: number;
  sessions_failed: AntigravityRepairFailure[];
  sessions_resummarized: number;
  rows_matched: number;
  rows_inserted: number;
  rows_updated: number;
  rows_deleted: number;
  legacy_ids_migrated: number;
  tokens_in_before: number;
  tokens_in_after: number;
  tokens_out_before: number;
  tokens_out_after: number;
  cache_read_tokens_before: number;
  cache_read_tokens_after: number;
  cache_write_tokens_before: number;
  cache_write_tokens_after: number;
  tokens_before: number;
  tokens_after: number;
  cost_before_usd: number;
  cost_after_usd: number;
};

interface StoredAntigravityEventRow {
  id: number;
  event_id: string;
  event_type: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model: string | null;
  project: string | null;
  cost_usd: number | null;
  cost_source: string | null;
  client_timestamp: string | null;
  created_at: string;
  metadata: string;
}

interface UsageAccumulator {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface SessionReconcileCounts {
  changed: boolean;
  matched: number;
  inserted: number;
  updated: number;
  deleted: number;
  migratedIds: number;
  before: UsageAccumulator;
  after: UsageAccumulator;
}

const PREVIEW_ROLLBACK = Symbol('antigravity-repair-preview');

function emptyUsage(): UsageAccumulator {
  return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addStoredUsage(acc: UsageAccumulator, row: StoredAntigravityEventRow): void {
  acc.tokensIn += row.tokens_in;
  acc.tokensOut += row.tokens_out;
  acc.cacheRead += row.cache_read_tokens;
  acc.cacheWrite += row.cache_write_tokens;
  acc.cost += row.cost_usd ?? 0;
}

function addParsedUsage(acc: UsageAccumulator, event: ParsedImportEvent): void {
  acc.tokensIn += event.tokens_in;
  acc.tokensOut += event.tokens_out;
  acc.cacheRead += event.cache_read_tokens ?? 0;
  acc.cacheWrite += event.cache_write_tokens ?? 0;
  acc.cost += event.cost_usd ?? 0;
}

function totalTokens(acc: UsageAccumulator): number {
  return acc.tokensIn + acc.tokensOut + acc.cacheRead + acc.cacheWrite;
}

function expectedCostSource(event: ParsedImportEvent): 'estimated' | null {
  return event.cost_usd != null ? 'estimated' : null;
}

function llmRowMatches(row: StoredAntigravityEventRow, event: ParsedImportEvent): boolean {
  return row.event_id === event.event_id
    && row.tokens_in === event.tokens_in
    && row.tokens_out === event.tokens_out
    && row.cache_read_tokens === (event.cache_read_tokens ?? 0)
    && row.cache_write_tokens === (event.cache_write_tokens ?? 0)
    && row.model === (event.model ?? null)
    && row.project === (event.project ?? null)
    && sameCost(row.cost_usd, event.cost_usd)
    && row.cost_source === expectedCostSource(event)
    && row.client_timestamp === (event.client_timestamp ?? null)
    && row.metadata === serializeEventMetadata(event.metadata);
}

function sqlDateTime(db: Database, iso: string): string {
  const row = db.prepare('SELECT datetime(?) AS dt').get(iso) as { dt: string };
  return row.dt;
}

function sessionRowNeedsReconcile(
  db: Database,
  snapshot: AntigravityConversationSnapshot,
): boolean {
  const row = db.prepare(
    'SELECT project, status, started_at, last_event_at, ended_at FROM sessions WHERE id = ?',
  ).get(snapshot.sessionId) as {
    project: string | null;
    status: string;
    started_at: string;
    last_event_at: string;
    ended_at: string | null;
  } | undefined;
  if (!row) return false;

  const hasNonImport = db.prepare(
    "SELECT 1 FROM events WHERE session_id = ? AND (source IS NULL OR source != 'import') LIMIT 1",
  ).get(snapshot.sessionId) !== undefined;
  if (hasNonImport) {
    return snapshot.summary?.project != null && row.project !== snapshot.summary.project;
  }

  if (snapshot.summary?.project != null && row.project !== snapshot.summary.project) {
    return true;
  }
  if (snapshot.startedAtIso) {
    const expectedStart = sqlDateTime(db, snapshot.startedAtIso);
    if (row.started_at !== expectedStart) return true;
  }
  if (snapshot.latestActivityIso) {
    const expectedLast = sqlDateTime(db, snapshot.latestActivityIso);
    if (row.last_event_at !== expectedLast) return true;
    if (row.status === 'ended' && row.ended_at !== expectedLast) return true;
  }
  return false;
}

function pairStaleRows(
  sessionId: string,
  staleRows: readonly StoredAntigravityEventRow[],
  missingEvents: readonly ParsedImportEvent[],
  identityByEventId: ReadonlyMap<string, GenerationIdentityMetadata>,
): {
  paired: Array<{ stale: StoredAntigravityEventRow; event: ParsedImportEvent }>;
  unpairedStale: StoredAntigravityEventRow[];
  unpairedMissing: ParsedImportEvent[];
} {
  const usedStaleIds = new Set<number>();
  const paired: Array<{ stale: StoredAntigravityEventRow; event: ParsedImportEvent }> = [];

  const contentMatched = matchLegacyAntigravityRows(
    sessionId,
    missingEvents,
    staleRows,
    identityByEventId,
    { ordinalBound: staleRows.length + missingEvents.length, requireOrdinalId: true },
  );

  const afterContent: ParsedImportEvent[] = [];
  for (const event of missingEvents) {
    const match = event.event_id ? contentMatched.get(event.event_id) : undefined;
    if (match && !usedStaleIds.has(match.id)) {
      usedStaleIds.add(match.id);
      paired.push({ stale: match, event });
    } else {
      afterContent.push(event);
    }
  }

  const staleById = new Map(staleRows.map((row) => [row.event_id, row]));
  const unmatchedEvents: ParsedImportEvent[] = [];
  for (const event of afterContent) {
    const exactLegacy = event.legacy_event_id ? staleById.get(event.legacy_event_id) : undefined;
    if (exactLegacy && !usedStaleIds.has(exactLegacy.id)) {
      usedStaleIds.add(exactLegacy.id);
      paired.push({ stale: exactLegacy, event });
    } else {
      unmatchedEvents.push(event);
    }
  }

  const remainingStale = staleRows.filter((row) => !usedStaleIds.has(row.id));
  const unpairedMissing: ParsedImportEvent[] = [];
  let staleCursor = 0;
  for (const event of unmatchedEvents) {
    if (staleCursor < remainingStale.length) {
      const stale = remainingStale[staleCursor++];
      usedStaleIds.add(stale.id);
      paired.push({ stale, event });
    } else {
      unpairedMissing.push(event);
    }
  }

  return {
    paired,
    unpairedStale: staleRows.filter((row) => !usedStaleIds.has(row.id)),
    unpairedMissing,
  };
}

function reconcileSessionInDb(
  db: Database,
  snapshot: AntigravityConversationSnapshot,
  parsedEvents: ParsedImportEvent[],
  fileHash: string,
  apply: boolean,
): SessionReconcileCounts {
  const counts: SessionReconcileCounts = {
    changed: false,
    matched: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    migratedIds: 0,
    before: emptyUsage(),
    after: emptyUsage(),
  };

  try {
    db.transaction(() => {
      const storedAll = db.prepare(`
        SELECT id, event_id, event_type,
               COALESCE(tokens_in, 0) AS tokens_in,
               COALESCE(tokens_out, 0) AS tokens_out,
               COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
               COALESCE(cache_write_tokens, 0) AS cache_write_tokens,
               model, project, cost_usd, cost_source, client_timestamp, created_at, metadata
        FROM events
        WHERE session_id = ? AND source = 'import' AND agent_type = 'antigravity' AND event_id LIKE 'import-agr-%'
      `).all(snapshot.sessionId) as StoredAntigravityEventRow[];

      const storedLlms = storedAll.filter((r) => r.event_type === 'llm_response');
      const storedOther = storedAll.filter((r) => r.event_type !== 'llm_response');
      const parsedGens = parsedEvents.filter((e) => e.event_type === 'llm_response');
      const parsedOtherById = new Map(
        parsedEvents.filter((e) => e.event_type !== 'llm_response' && e.event_id).map((e) => [e.event_id!, e]),
      );

      for (const row of storedLlms) addStoredUsage(counts.before, row);
      for (const event of parsedGens) addParsedUsage(counts.after, event);

      const expectedById = new Map(parsedGens.map((e) => [e.event_id!, e]));
      const storedById = new Map(storedLlms.map((r) => [r.event_id, r]));

      const matchedCanonical: Array<{ row: StoredAntigravityEventRow; event: ParsedImportEvent }> = [];
      for (const event of parsedGens) {
        const existing = storedById.get(event.event_id!);
        if (existing) matchedCanonical.push({ row: existing, event });
      }

      const staleRows = storedLlms.filter((row) => !expectedById.has(row.event_id));
      const missingEvents = parsedGens.filter((e) => !storedById.has(e.event_id!));
      const { paired, unpairedStale, unpairedMissing } = pairStaleRows(
        snapshot.sessionId,
        staleRows,
        missingEvents,
        generationIdentityMetadataByEventId(snapshot),
      );

      counts.matched = matchedCanonical.length + paired.length;

      const deleteStmt = db.prepare('DELETE FROM events WHERE id = ?');
      for (const row of unpairedStale) {
        deleteStmt.run(row.id);
        counts.deleted++;
      }

      const updateLlmStmt = db.prepare(`
        UPDATE events
        SET event_id = @event_id,
            tokens_in = @tokens_in,
            tokens_out = @tokens_out,
            cache_read_tokens = @cache_read_tokens,
            cache_write_tokens = @cache_write_tokens,
            model = @model,
            project = @project,
            cost_usd = @cost_usd,
            cost_source = @cost_source,
            client_timestamp = @client_timestamp,
            metadata = @metadata,
            payload_truncated = 0
        WHERE id = @id
      `);

      for (const { row, event } of matchedCanonical) {
        const serializedMeta = serializeEventMetadata(event.metadata);
        if (!llmRowMatches(row, event)) {
          updateLlmStmt.run({
            id: row.id,
            event_id: event.event_id,
            tokens_in: event.tokens_in,
            tokens_out: event.tokens_out,
            cache_read_tokens: event.cache_read_tokens ?? 0,
            cache_write_tokens: event.cache_write_tokens ?? 0,
            model: event.model ?? null,
            project: event.project ?? null,
            cost_usd: event.cost_usd ?? null,
            cost_source: expectedCostSource(event),
            client_timestamp: event.client_timestamp ?? null,
            metadata: serializedMeta,
          });
          counts.updated++;
        }
      }

      for (const { stale, event } of paired) {
        updateLlmStmt.run({
          id: stale.id,
          event_id: event.event_id,
          tokens_in: event.tokens_in,
          tokens_out: event.tokens_out,
          cache_read_tokens: event.cache_read_tokens ?? 0,
          cache_write_tokens: event.cache_write_tokens ?? 0,
          model: event.model ?? null,
          project: event.project ?? null,
          cost_usd: event.cost_usd ?? null,
          cost_source: expectedCostSource(event),
          client_timestamp: event.client_timestamp ?? null,
          metadata: serializeEventMetadata(event.metadata),
        });
        counts.updated++;
        counts.migratedIds++;
      }

      const insertLlmStmt = db.prepare(`
        INSERT INTO events (
          event_id, schema_version, session_id, agent_type, event_type, tool_name, status,
          tokens_in, tokens_out, branch, project, duration_ms, created_at, client_timestamp,
          metadata, payload_truncated, model, cost_usd, cache_read_tokens, cache_write_tokens,
          cache_write_1h_tokens, source, cost_source
        ) VALUES (
          @event_id, 1, @session_id, 'antigravity', 'llm_response', NULL, 'success',
          @tokens_in, @tokens_out, NULL, @project, NULL, datetime('now'), @client_timestamp,
          @metadata, 0, @model, @cost_usd, @cache_read_tokens, @cache_write_tokens,
          0, 'import', @cost_source
        )
      `);

      for (const event of unpairedMissing) {
        insertLlmStmt.run({
          event_id: event.event_id,
          session_id: snapshot.sessionId,
          tokens_in: event.tokens_in,
          tokens_out: event.tokens_out,
          project: event.project ?? null,
          client_timestamp: event.client_timestamp ?? null,
          metadata: serializeEventMetadata(event.metadata),
          model: event.model ?? null,
          cost_usd: event.cost_usd ?? null,
          cache_read_tokens: event.cache_read_tokens ?? 0,
          cache_write_tokens: event.cache_write_tokens ?? 0,
          cost_source: expectedCostSource(event),
        });
        counts.inserted++;
      }

      const updateOtherProject = db.prepare('UPDATE events SET project = ? WHERE id = ?');
      let otherUpdated = 0;
      for (const row of storedOther) {
        const parsed = parsedOtherById.get(row.event_id);
        if (parsed && parsed.project != null && row.project !== parsed.project) {
          updateOtherProject.run(parsed.project, row.id);
          otherUpdated++;
        }
      }

      const storedOtherIds = new Set(storedOther.map((row) => row.event_id));
      const hasMissingOther = parsedEvents.some(
        (event) => event.event_type !== 'llm_response' && event.event_id && !storedOtherIds.has(event.event_id),
      );
      const sessionChanged = sessionRowNeedsReconcile(db, snapshot);
      counts.changed = (counts.inserted + counts.updated + counts.deleted + otherUpdated > 0) || sessionChanged;

      if (counts.changed) {
        reconcileAntigravitySessionLifecycle(db, snapshot);
        maintainSessionTraceSummary(snapshot.sessionId, db);
        if (!hasMissingOther) {
          upsertAntigravityImportState(db, snapshot.filePath, fileHash, counts.inserted);
        }
      }

      if (!apply) throw PREVIEW_ROLLBACK;
    })();
  } catch (err) {
    if (err !== PREVIEW_ROLLBACK) throw err;
  }

  return counts;
}

function repairWithin(
  db: Database,
  apply: boolean,
  options: AntigravityUsageRepairOptions,
): AntigravityUsageRepairReport {
  const report: AntigravityUsageRepairReport = {
    apply,
    files_scanned: 0,
    files_unreadable: 0,
    sessions_without_source: 0,
    sessions_changed: 0,
    sessions_failed: [],
    sessions_resummarized: 0,
    rows_matched: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_deleted: 0,
    legacy_ids_migrated: 0,
    tokens_in_before: 0,
    tokens_in_after: 0,
    tokens_out_before: 0,
    tokens_out_after: 0,
    cache_read_tokens_before: 0,
    cache_read_tokens_after: 0,
    cache_write_tokens_before: 0,
    cache_write_tokens_after: 0,
    tokens_before: 0,
    tokens_after: 0,
    cost_before_usd: 0,
    cost_after_usd: 0,
  };

  const files = discoverAntigravityLogs(options.antigravityDir, { excludePatterns: options.excludePatterns });
  const fileSessionIds = new Set(files.map((f) => path.basename(f, '.db')));

  const storedSessionIds = (db.prepare(`
    SELECT DISTINCT session_id
    FROM events
    WHERE source = 'import' AND agent_type = 'antigravity' AND event_id LIKE 'import-agr-%'
  `).all() as Array<{ session_id: string }>).map((row) => row.session_id);
  const storedSessionSet = new Set(storedSessionIds);

  for (const sessionId of storedSessionIds) {
    if (!fileSessionIds.has(sessionId)) report.sessions_without_source++;
  }

  for (const filePath of files) {
    report.files_scanned++;
    const sessionId = path.basename(filePath, '.db');
    if (!storedSessionSet.has(sessionId)) continue;

    let snapshot: AntigravityConversationSnapshot;
    let fileHash: string;
    try {
      fileHash = hashAntigravityConversation(filePath);
      snapshot = readAntigravityConversationSnapshot(filePath, {
        includeTranscript: false,
        includeSummary: true,
        throwOnError: true,
      });
    } catch {
      report.files_unreadable++;
      continue;
    }

    if (!snapshot.dbPresent || !snapshot.hasGenMetadataTable) {
      report.files_unreadable++;
      continue;
    }

    const parsedEvents = antigravitySnapshotToEvents(snapshot);

    let counts: SessionReconcileCounts;
    try {
      counts = reconcileSessionInDb(db, snapshot, parsedEvents, fileHash, apply);
    } catch (err) {
      report.sessions_failed.push({
        conversation: path.basename(filePath),
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    report.rows_matched += counts.matched;
    if (!counts.changed) continue;

    report.sessions_changed++;
    report.sessions_resummarized++;
    report.rows_inserted += counts.inserted;
    report.rows_updated += counts.updated;
    report.rows_deleted += counts.deleted;
    report.legacy_ids_migrated += counts.migratedIds;

    report.tokens_in_before += counts.before.tokensIn;
    report.tokens_in_after += counts.after.tokensIn;
    report.tokens_out_before += counts.before.tokensOut;
    report.tokens_out_after += counts.after.tokensOut;
    report.cache_read_tokens_before += counts.before.cacheRead;
    report.cache_read_tokens_after += counts.after.cacheRead;
    report.cache_write_tokens_before += counts.before.cacheWrite;
    report.cache_write_tokens_after += counts.after.cacheWrite;
    report.tokens_before += totalTokens(counts.before);
    report.tokens_after += totalTokens(counts.after);
    report.cost_before_usd += counts.before.cost;
    report.cost_after_usd += counts.after.cost;
  }

  report.cost_before_usd = Math.round(report.cost_before_usd * 1e10) / 1e10;
  report.cost_after_usd = Math.round(report.cost_after_usd * 1e10) / 1e10;

  if (apply && report.sessions_changed > 0) {
    markStatsDirty();
  }

  return report;
}

export function repairAntigravityImportUsage(
  db: Database,
  options: AntigravityUsageRepairOptions = {},
): AntigravityUsageRepairReport {
  const apply = options.apply === true;
  const ownership = apply ? acquireRuntimeOwnership(options.dbPath ?? db.name) : null;
  try {
    return repairWithin(db, apply, options);
  } finally {
    ownership?.release();
  }
}
