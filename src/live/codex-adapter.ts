import type Database from 'better-sqlite3';
import { config } from '../config.js';
import type { EventRow } from '../db/queries.js';
import {
  applyLivePrivacyPolicy,
  normalizeCodexItem,
  type CanonicalLiveItem,
  type LivePrivacyPolicy,
} from './normalize.js';

export interface CodexSummaryLiveSyncResult {
  inserted_turns: number;
  inserted_items: number;
  live_status: string;
  last_item_at: string;
  fidelity: 'summary';
  integration_mode: string;
}

function parseMetadata(row: EventRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deriveTimestamp(row: EventRow): string {
  return row.client_timestamp ?? row.created_at;
}

function deriveLiveStatus(row: EventRow, timestamp: string): string {
  if (row.event_type === 'session_end' || row.source === 'import') return 'ended';

  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (Number.isNaN(diffMs)) return 'available';
  if (diffMs <= 5 * 60_000) return 'live';
  if (diffMs <= 15 * 60_000) return 'active';
  return 'ended';
}

function integrationModeFor(row: EventRow): string {
  switch (row.source) {
    case 'otel':
      return 'codex-otel';
    case 'import':
      return 'codex-import';
    default:
      return 'codex-summary';
  }
}

function titleFor(row: EventRow, metadata: Record<string, unknown>): string {
  if (row.event_type === 'user_prompt' && typeof metadata.message === 'string' && metadata.message.trim()) {
    return metadata.message.trim().slice(0, 120);
  }
  if (row.event_type === 'tool_use' && row.tool_name) {
    return `Tool ${row.tool_name}`;
  }
  if (row.event_type === 'file_change' && typeof metadata.file_path === 'string') {
    return `Changed ${metadata.file_path}`;
  }
  if (row.event_type === 'llm_response' && row.model) {
    return `Model response (${row.model})`;
  }
  if (row.event_type === 'session_start') return 'Session started';
  if (row.event_type === 'session_end') return 'Session ended';
  if (row.event_type === 'error') return 'Error';
  return row.event_type.replace(/_/g, ' ');
}

function buildCodexSummaryLiveItem(row: EventRow, metadata: Record<string, unknown>): CanonicalLiveItem | null {
  const createdAt = deriveTimestamp(row);

  switch (row.event_type) {
    case 'user_prompt':
      return normalizeCodexItem({
        type: 'user_message',
        id: row.event_id ?? `codex-event:${row.id}`,
        created_at: createdAt,
        status: row.status,
        payload: {
          text: typeof metadata.message === 'string' ? metadata.message : '',
        },
      });
    case 'tool_use':
      return normalizeCodexItem({
        type: 'mcpToolCall',
        id: row.event_id ?? `codex-event:${row.id}`,
        created_at: createdAt,
        status: row.status,
        payload: {
          tool_name: row.tool_name ?? 'unknown',
          ...metadata,
        },
      });
    case 'file_change':
      return normalizeCodexItem({
        type: 'fileChange',
        id: row.event_id ?? `codex-event:${row.id}`,
        created_at: createdAt,
        status: row.status,
        payload: metadata,
      });
    case 'llm_response':
      return normalizeCodexItem({
        type: 'assistant_message',
        id: row.event_id ?? `codex-event:${row.id}`,
        created_at: createdAt,
        status: row.status,
        payload: {
          summary: 'Model response',
          model: row.model,
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
          cache_read_tokens: row.cache_read_tokens,
          cache_write_tokens: row.cache_write_tokens,
          cost_usd: row.cost_usd,
        },
      });
    case 'session_start':
    case 'session_end':
    case 'error':
      return normalizeCodexItem({
        type: 'status',
        id: row.event_id ?? `codex-event:${row.id}`,
        created_at: createdAt,
        status: row.event_type,
        payload: {
          event_type: row.event_type,
          status: row.status,
        },
      });
    default:
      return null;
  }
}

export function normalizeCodexExporterRecord(input: {
  type: string;
  created_at?: string;
  id?: string;
  status?: string;
  payload?: Record<string, unknown>;
}): CanonicalLiveItem | null {
  return normalizeCodexItem(input);
}

export function syncCodexSummaryLiveEvent(
  db: Database.Database,
  row: EventRow,
  options: { privacyPolicy?: LivePrivacyPolicy } = {},
): CodexSummaryLiveSyncResult {
  const metadata = parseMetadata(row);
  const timestamp = deriveTimestamp(row);
  const liveStatus = deriveLiveStatus(row, timestamp);
  const integrationMode = integrationModeFor(row);
  const privacyPolicy = options.privacyPolicy ?? {
    capturePrompts: config.live.capture.prompts,
    captureReasoning: config.live.capture.reasoning,
    captureToolArguments: config.live.capture.toolArguments,
    diffPayloadMaxBytes: config.live.diffPayloadMaxBytes,
  };

  const normalizedItem = buildCodexSummaryLiveItem(row, metadata);
  const item = normalizedItem ? applyLivePrivacyPolicy(normalizedItem, privacyPolicy) : null;
  const endedAt = row.event_type === 'session_end' || row.source === 'import' ? timestamp : null;
  const firstMessage = row.event_type === 'user_prompt' && typeof metadata.message === 'string'
    ? metadata.message.slice(0, 400)
    : null;
  const messageCount = item && (item.kind === 'user_message' || item.kind === 'assistant_message') ? 1 : 0;
  const userMessageCount = item?.kind === 'user_message' ? 1 : 0;

  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
      live_status, last_item_at, integration_mode, fidelity
    ) VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, 'summary')
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(excluded.project, browsing_sessions.project),
      first_message = COALESCE(browsing_sessions.first_message, excluded.first_message),
      started_at = COALESCE(browsing_sessions.started_at, excluded.started_at),
      ended_at = COALESCE(excluded.ended_at, browsing_sessions.ended_at),
      message_count = browsing_sessions.message_count + excluded.message_count,
      user_message_count = browsing_sessions.user_message_count + excluded.user_message_count,
      live_status = excluded.live_status,
      last_item_at = excluded.last_item_at,
      integration_mode = excluded.integration_mode,
      fidelity = excluded.fidelity
  `).run(
    row.session_id,
    row.project,
    firstMessage,
    timestamp,
    endedAt,
    messageCount,
    userMessageCount,
    liveStatus,
    timestamp,
    integrationMode,
  );

  let insertedTurns = 0;
  let insertedItems = 0;
  const sourceTurnId = row.event_id ?? `codex-event:${row.id}`;
  const existingTurn = db.prepare(
    'SELECT id FROM session_turns WHERE session_id = ? AND source_turn_id = ?'
  ).get(row.session_id, sourceTurnId) as { id: number } | undefined;

  let turnId = existingTurn?.id;
  if (!turnId) {
    const result = db.prepare(`
      INSERT INTO session_turns (
        session_id, agent_type, source_turn_id, status, title, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.session_id,
      row.agent_type,
      sourceTurnId,
      row.status,
      titleFor(row, metadata),
      timestamp,
      endedAt ?? timestamp,
    );
    turnId = Number(result.lastInsertRowid);
    insertedTurns = 1;
  }

  if (item) {
    const sourceItemId = item.source_item_id ?? sourceTurnId;
    const existingItem = db.prepare(
      'SELECT id FROM session_items WHERE session_id = ? AND source_item_id = ?'
    ).get(row.session_id, sourceItemId) as { id: number } | undefined;

    if (!existingItem) {
      db.prepare(`
        INSERT INTO session_items (
          session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.session_id,
        turnId,
        0,
        sourceItemId,
        item.kind,
        item.status ?? row.status,
        JSON.stringify(item.payload),
        item.created_at ?? timestamp,
      );
      insertedItems = 1;
    }
  }

  return {
    inserted_turns: insertedTurns,
    inserted_items: insertedItems,
    live_status: liveStatus,
    last_item_at: timestamp,
    fidelity: 'summary',
    integration_mode: integrationMode,
  };
}
