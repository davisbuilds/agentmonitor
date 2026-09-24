import type Database from 'better-sqlite3';
import type { CanonicalLiveItem } from './normalize.js';

export type ProjectionFidelity = 'summary' | 'full';
export type ProjectionCapabilityLevel = 'none' | 'summary' | 'full';

export interface ProjectionCapabilities {
  history: ProjectionCapabilityLevel;
  search: ProjectionCapabilityLevel;
  tool_analytics: ProjectionCapabilityLevel;
  live_items: ProjectionCapabilityLevel;
}

export interface ProjectionContract {
  integration_mode: string;
  fidelity: ProjectionFidelity;
  capabilities: ProjectionCapabilities;
}

export interface ProjectedSessionSnapshot {
  id: string;
  agent: string;
  project: string | null;
  first_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  user_message_count: number;
  live_status: string | null;
  last_item_at: string | null;
  context_used_tokens?: number | null;
  context_window_tokens?: number | null;
}

export interface ProjectedSessionIncrement {
  id: string;
  agent: string;
  project: string | null;
  first_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count_delta: number;
  user_message_count_delta: number;
  live_status: string | null;
  last_item_at: string | null;
}

export interface ProjectedTurnInput {
  agent_type: string;
  source_turn_id?: string | null;
  status?: string | null;
  title?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

export interface ProjectedItemInput {
  ordinal: number;
  source_item_id?: string | null;
  kind: CanonicalLiveItem['kind'];
  status?: string | null;
  payload: Record<string, unknown>;
  created_at?: string | null;
}

export const FULL_PROJECTION_CAPABILITIES: ProjectionCapabilities = Object.freeze({
  history: 'full',
  search: 'full',
  tool_analytics: 'full',
  live_items: 'full',
});

export const SUMMARY_LIVE_PROJECTION_CAPABILITIES: ProjectionCapabilities = Object.freeze({
  history: 'none',
  search: 'none',
  tool_analytics: 'none',
  live_items: 'summary',
});

function cloneCapabilities(capabilities: ProjectionCapabilities): ProjectionCapabilities {
  return { ...capabilities };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeCapabilityLevel(value: unknown): ProjectionCapabilityLevel | null {
  return value === 'none' || value === 'summary' || value === 'full' ? value : null;
}

function normalizeProjectionCapabilities(
  value: unknown,
  fallback: ProjectionCapabilities = FULL_PROJECTION_CAPABILITIES,
): ProjectionCapabilities {
  const record = asRecord(value);
  if (!record) return cloneCapabilities(fallback);

  return {
    history: normalizeCapabilityLevel(record['history']) ?? fallback.history,
    search: normalizeCapabilityLevel(record['search']) ?? fallback.search,
    tool_analytics: normalizeCapabilityLevel(record['tool_analytics']) ?? fallback.tool_analytics,
    live_items: normalizeCapabilityLevel(record['live_items']) ?? fallback.live_items,
  };
}

function serializeProjectionCapabilities(capabilities: ProjectionCapabilities): string {
  return JSON.stringify(normalizeProjectionCapabilities(capabilities));
}

export function inferProjectionCapabilities(input: {
  capabilities_json?: string | null;
  fidelity?: string | null;
  integration_mode?: string | null;
}): ProjectionCapabilities | null {
  if (input.capabilities_json) {
    try {
      return normalizeProjectionCapabilities(JSON.parse(input.capabilities_json), projectionCapabilityFallback(input));
    } catch {
      return normalizeProjectionCapabilities(null, projectionCapabilityFallback(input));
    }
  }

  if (!input.fidelity && !input.integration_mode) return null;
  return cloneCapabilities(projectionCapabilityFallback(input));
}

function projectionCapabilityFallback(input: {
  fidelity?: string | null;
  integration_mode?: string | null;
}): ProjectionCapabilities {
  if (input.integration_mode === 'claude-jsonl' || input.fidelity === 'full') {
    return FULL_PROJECTION_CAPABILITIES;
  }
  return SUMMARY_LIVE_PROJECTION_CAPABILITIES;
}

function serializeContract(contract: ProjectionContract): {
  integration_mode: string;
  fidelity: ProjectionFidelity;
  capabilities_json: string;
} {
  return {
    integration_mode: contract.integration_mode,
    fidelity: contract.fidelity,
    capabilities_json: serializeProjectionCapabilities(contract.capabilities),
  };
}

export function clearProjectedSessionStream(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM session_items WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId);
}

/**
 * Remove the summary-projected turn and item that one source event produced.
 * Summary projections key both on the event id, so an event that was deleted
 * or rewritten can be dropped here and, if it still exists, projected again.
 */
export function removeProjectedSourceEvent(db: Database.Database, sessionId: string, sourceId: string): void {
  db.prepare('DELETE FROM session_items WHERE session_id = ? AND source_item_id = ?').run(sessionId, sourceId);
  db.prepare('DELETE FROM session_turns WHERE session_id = ? AND source_turn_id = ?').run(sessionId, sourceId);
}

/**
 * Recount a summary projection's message counters from its items. Summary
 * projections accumulate the counters by increment, which drifts once items are
 * removed or projected again.
 */
export function recountProjectedSummaryMessages(db: Database.Database, sessionId: string): void {
  db.prepare(`
    UPDATE browsing_sessions
    SET message_count = (
          SELECT COUNT(*) FROM session_items
          WHERE session_id = @id AND kind IN ('user_message', 'assistant_message')
        ),
        user_message_count = (
          SELECT COUNT(*) FROM session_items WHERE session_id = @id AND kind = 'user_message'
        )
    WHERE id = @id AND fidelity = 'summary'
  `).run({ id: sessionId });
}

/**
 * Projecting one row moves the session's end to that row's time. After rows
 * are re-projected out of order, put it back at the latest projected turn.
 */
export function restoreProjectedSessionBounds(db: Database.Database, sessionId: string): void {
  db.prepare(`
    UPDATE browsing_sessions
    SET ended_at = COALESCE(latest.at, ended_at),
        last_item_at = COALESCE(latest.at, last_item_at)
    FROM (
      SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM session_turns WHERE session_id = @id
    ) AS latest
    WHERE id = @id AND fidelity = 'summary'
  `).run({ id: sessionId });
}

export function upsertProjectedSessionSnapshot(
  db: Database.Database,
  session: ProjectedSessionSnapshot,
  contract: ProjectionContract,
): void {
  const encoded = serializeContract(contract);
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
      live_status, last_item_at, integration_mode, fidelity, capabilities_json,
      context_used_tokens, context_window_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(excluded.project, browsing_sessions.project),
      agent = COALESCE(excluded.agent, browsing_sessions.agent),
      first_message = COALESCE(excluded.first_message, browsing_sessions.first_message),
      started_at = COALESCE(excluded.started_at, browsing_sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, browsing_sessions.ended_at),
      message_count = excluded.message_count,
      user_message_count = excluded.user_message_count,
      live_status = COALESCE(excluded.live_status, browsing_sessions.live_status),
      last_item_at = COALESCE(excluded.last_item_at, browsing_sessions.last_item_at),
      integration_mode = excluded.integration_mode,
      fidelity = excluded.fidelity,
      capabilities_json = excluded.capabilities_json,
      -- Occupancy always reflects the latest sync (excluded), but never clobbers
      -- a known value with NULL (e.g. a summary sync that carries no usage).
      context_used_tokens = COALESCE(excluded.context_used_tokens, browsing_sessions.context_used_tokens),
      context_window_tokens = COALESCE(excluded.context_window_tokens, browsing_sessions.context_window_tokens)
  `).run(
    session.id,
    session.project,
    session.agent,
    session.first_message,
    session.started_at,
    session.ended_at,
    session.message_count,
    session.user_message_count,
    session.live_status,
    session.last_item_at,
    encoded.integration_mode,
    encoded.fidelity,
    encoded.capabilities_json,
    session.context_used_tokens ?? null,
    session.context_window_tokens ?? null,
  );
}

export function upsertProjectedSessionIncrement(
  db: Database.Database,
  session: ProjectedSessionIncrement,
  contract: ProjectionContract,
  options: { clearEndedAtOnActive?: boolean } = {},
): void {
  const encoded = serializeContract(contract);
  const clearEndedAtOnActive = options.clearEndedAtOnActive === true;

  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
      live_status, last_item_at, integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(excluded.project, browsing_sessions.project),
      agent = COALESCE(excluded.agent, browsing_sessions.agent),
      first_message = COALESCE(browsing_sessions.first_message, excluded.first_message),
      started_at = COALESCE(browsing_sessions.started_at, excluded.started_at),
      ended_at = CASE
        WHEN excluded.ended_at IS NOT NULL THEN excluded.ended_at
        WHEN ${clearEndedAtOnActive ? "excluded.live_status IN ('live', 'active', 'available')" : '0'} THEN NULL
        ELSE browsing_sessions.ended_at
      END,
      message_count = browsing_sessions.message_count + excluded.message_count,
      user_message_count = browsing_sessions.user_message_count + excluded.user_message_count,
      live_status = COALESCE(excluded.live_status, browsing_sessions.live_status),
      last_item_at = COALESCE(excluded.last_item_at, browsing_sessions.last_item_at),
      integration_mode = excluded.integration_mode,
      fidelity = excluded.fidelity,
      capabilities_json = excluded.capabilities_json
  `).run(
    session.id,
    session.project,
    session.agent,
    session.first_message,
    session.started_at,
    session.ended_at,
    session.message_count_delta,
    session.user_message_count_delta,
    session.live_status,
    session.last_item_at,
    encoded.integration_mode,
    encoded.fidelity,
    encoded.capabilities_json,
  );
}

export function insertProjectedTurn(
  db: Database.Database,
  sessionId: string,
  turn: ProjectedTurnInput,
): number {
  const result = db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turn.agent_type,
    turn.source_turn_id ?? null,
    turn.status ?? null,
    turn.title ?? null,
    turn.started_at ?? null,
    turn.ended_at ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function ensureProjectedTurn(
  db: Database.Database,
  sessionId: string,
  turn: ProjectedTurnInput,
): { id: number; inserted: boolean } {
  if (turn.source_turn_id) {
    const existing = db.prepare(
      'SELECT id FROM session_turns WHERE session_id = ? AND source_turn_id = ?'
    ).get(sessionId, turn.source_turn_id) as { id: number } | undefined;
    if (existing) return { id: existing.id, inserted: false };
  }

  return {
    id: insertProjectedTurn(db, sessionId, turn),
    inserted: true,
  };
}

export function insertProjectedItem(
  db: Database.Database,
  sessionId: string,
  turnId: number | null,
  item: ProjectedItemInput,
): void {
  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnId,
    item.ordinal,
    item.source_item_id ?? null,
    item.kind,
    item.status ?? null,
    JSON.stringify(item.payload),
    item.created_at ?? null,
  );
}

export function ensureProjectedItem(
  db: Database.Database,
  sessionId: string,
  turnId: number | null,
  item: ProjectedItemInput,
): boolean {
  if (item.source_item_id) {
    const existing = db.prepare(
      'SELECT id FROM session_items WHERE session_id = ? AND source_item_id = ?'
    ).get(sessionId, item.source_item_id) as { id: number } | undefined;
    if (existing) return false;
  }

  insertProjectedItem(db, sessionId, turnId, item);
  return true;
}

/** The browser row's producer mode, or null when the session has none. */
export function getBrowsingIntegrationMode(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT integration_mode FROM browsing_sessions WHERE id = ?').get(sessionId) as
    { integration_mode: string | null } | undefined;
  return row ? row.integration_mode ?? '' : null;
}

/** Source ids of a session's projected turns. */
export function listProjectedTurnSourceIds(db: Database.Database, sessionId: string): string[] {
  return (db.prepare('SELECT source_turn_id FROM session_turns WHERE session_id = ? AND source_turn_id IS NOT NULL')
    .all(sessionId) as Array<{ source_turn_id: string }>).map(row => row.source_turn_id);
}

/** Source ids of a session's projected items. */
export function listProjectedItemSourceIds(db: Database.Database, sessionId: string): string[] {
  return (db.prepare('SELECT source_item_id FROM session_items WHERE session_id = ? AND source_item_id IS NOT NULL')
    .all(sessionId) as Array<{ source_item_id: string }>).map(row => row.source_item_id);
}
