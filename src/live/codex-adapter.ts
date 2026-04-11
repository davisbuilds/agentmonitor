import type Database from 'better-sqlite3';
import { config } from '../config.js';
import type { EventRow } from '../db/queries.js';
import {
  applyLivePrivacyPolicy,
  normalizeCodexItem,
  type CanonicalLiveItem,
  type LivePrivacyPolicy,
} from './normalize.js';
import {
  ensureProjectedItem,
  ensureProjectedTurn,
  SUMMARY_LIVE_PROJECTION_CAPABILITIES,
  upsertProjectedSessionIncrement,
} from './projector.js';

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

function getString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function getBoolean(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getCodexText(metadata: Record<string, unknown>): string | undefined {
  return getString(metadata, 'text')
    ?? getString(metadata, 'message')
    ?? getString(metadata, 'content_preview')
    ?? getString(metadata, 'output');
}

function getResponseItemType(metadata: Record<string, unknown>): string | undefined {
  return getString(metadata, 'response_item_type');
}

function getOtelEventName(metadata: Record<string, unknown>): string | undefined {
  return getString(metadata, 'otel_event_name');
}

function getSourceItemId(row: EventRow, metadata: Record<string, unknown>, suffix?: string): string {
  const callId = getString(metadata, 'call_id');
  if (callId && suffix) return `${callId}:${suffix}`;
  return row.event_id ?? `codex-event:${row.id}`;
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
  if (row.event_type === 'response') {
    const responseText = getCodexText(metadata);
    const responseItemType = getResponseItemType(metadata);
    if (responseText?.trim()) return responseText.trim().slice(0, 120);
    if (responseItemType) return responseItemType.replace(/_/g, ' ');
    return 'Response item';
  }
  if (row.event_type === 'tool_use' && row.tool_name) {
    return getOtelEventName(metadata) === 'codex.tool_result'
      ? `Tool result ${row.tool_name}`
      : `Tool ${row.tool_name}`;
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

function buildCodexToolItem(row: EventRow, metadata: Record<string, unknown>, createdAt: string): CanonicalLiveItem {
  const otelEventName = getOtelEventName(metadata);

  if (otelEventName === 'codex.tool_result') {
    return normalizeCodexItem({
      type: 'tool_result',
      id: getSourceItemId(row, metadata, 'result'),
      created_at: createdAt,
      status: row.status,
      payload: {
        tool_name: row.tool_name ?? 'unknown',
        call_id: getString(metadata, 'call_id'),
        output: getString(metadata, 'output') ?? getString(metadata, 'content_preview') ?? '',
        success: getBoolean(metadata, 'success'),
        mcp_server: getString(metadata, 'mcp_server'),
        mcp_server_origin: getString(metadata, 'mcp_server_origin'),
      },
    })!;
  }

  return normalizeCodexItem({
    type: 'mcpToolCall',
    id: getSourceItemId(row, metadata, otelEventName === 'codex.tool_decision' ? 'decision' : undefined),
    created_at: createdAt,
    status: row.status,
    payload: {
      tool_name: row.tool_name ?? 'unknown',
      input: metadata.arguments ?? metadata.input ?? null,
      ...metadata,
    },
  })!;
}

function buildCodexResponseItem(row: EventRow, metadata: Record<string, unknown>, createdAt: string): CanonicalLiveItem | null {
  const responseItemType = getResponseItemType(metadata);
  const text = getCodexText(metadata);
  const baseId = row.event_id ?? `codex-event:${row.id}`;

  switch (responseItemType) {
    case 'message_from_user':
      return normalizeCodexItem({
        type: 'user_message',
        id: baseId,
        created_at: createdAt,
        status: row.status,
        payload: { text: text ?? '' },
      });
    case 'assistant_message':
    case 'agent_message':
    case 'message_from_assistant':
      return normalizeCodexItem({
        type: 'assistant_message',
        id: baseId,
        created_at: createdAt,
        status: row.status,
        payload: { text: text ?? '', item_type: responseItemType },
      });
    case 'reasoning':
    case 'reasoning_summary_delta':
    case 'reasoning_content_delta':
    case 'reasoning_summary_part_added':
      return normalizeCodexItem({
        type: 'reasoning',
        id: baseId,
        created_at: createdAt,
        status: row.status,
        payload: { text: text ?? '', item_type: responseItemType },
      });
    case 'local_shell_call':
      return normalizeCodexItem({
        type: 'commandExecution',
        id: baseId,
        created_at: createdAt,
        status: row.status,
        payload: {
          command: metadata.arguments ?? metadata.input ?? text ?? '',
          item_type: responseItemType,
          ...metadata,
        },
      });
    case 'function_call':
    case 'tool_search_call':
    case 'custom_tool_call':
    case 'web_search_call':
    case 'image_generation_call':
      return normalizeCodexItem({
        type: 'mcpToolCall',
        id: baseId,
        created_at: createdAt,
        status: row.status,
        payload: {
          tool_name: row.tool_name ?? responseItemType,
          input: metadata.arguments ?? metadata.input ?? null,
          item_type: responseItemType,
          ...metadata,
        },
      });
    case 'function_call_output':
    case 'tool_search_output':
    case 'custom_tool_call_output':
      return normalizeCodexItem({
        type: 'tool_result',
        id: baseId,
        created_at: createdAt,
        status: row.status,
        payload: {
          tool_name: row.tool_name ?? responseItemType,
          content: text ?? '',
          item_type: responseItemType,
        },
      });
    default:
      if (text) {
        return normalizeCodexItem({
          type: 'assistant_message',
          id: baseId,
          created_at: createdAt,
          status: row.status,
          payload: {
            text,
            item_type: responseItemType ?? 'response',
          },
        });
      }
      return null;
  }
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
      return buildCodexToolItem(row, metadata, createdAt);
    case 'response':
      return buildCodexResponseItem(row, metadata, createdAt);
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
          event_kind: getString(metadata, 'event_kind'),
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
          cache_read_tokens: row.cache_read_tokens,
          cache_write_tokens: row.cache_write_tokens,
          cost_usd: row.cost_usd,
          reasoning_token_count: metadata.reasoning_token_count,
          tool_token_count: metadata.tool_token_count,
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
  upsertProjectedSessionIncrement(db, {
    id: row.session_id,
    agent: 'codex',
    project: row.project,
    first_message: firstMessage,
    started_at: timestamp,
    ended_at: endedAt,
    message_count_delta: messageCount,
    user_message_count_delta: userMessageCount,
    live_status: liveStatus,
    last_item_at: timestamp,
  }, {
    integration_mode: integrationMode,
    fidelity: 'summary',
    capabilities: SUMMARY_LIVE_PROJECTION_CAPABILITIES,
  }, {
    clearEndedAtOnActive: true,
  });

  let insertedItems = 0;
  const sourceTurnId = row.event_id ?? `codex-event:${row.id}`;
  const ensuredTurn = ensureProjectedTurn(db, row.session_id, {
    agent_type: row.agent_type,
    source_turn_id: sourceTurnId,
    status: row.status,
    title: titleFor(row, metadata),
    started_at: timestamp,
    ended_at: endedAt ?? timestamp,
  });
  const turnId = ensuredTurn.id;
  const insertedTurns = ensuredTurn.inserted ? 1 : 0;

  if (item) {
    const sourceItemId = item.source_item_id ?? sourceTurnId;
    insertedItems = ensureProjectedItem(db, row.session_id, turnId, {
      ordinal: 0,
      source_item_id: sourceItemId,
      kind: item.kind,
      status: item.status ?? row.status,
      payload: item.payload,
      created_at: item.created_at ?? timestamp,
    }) ? 1 : 0;
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
