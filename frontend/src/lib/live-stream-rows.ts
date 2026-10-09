import type { LiveItem } from './api/client';
import { parseSessionText } from './session-text';

/** One row of the Live stream: an item, plus the tool result folded into its call. */
export interface LiveStreamRow {
  item: LiveItem;
  result: LiveItem | null;
}

function parsePayload(item: LiveItem): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(item.payload_json) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Claude calls and results share the tool_use id as source_item_id; Codex ids
// them `<call_id>:decision` and `<call_id>:result` and carries call_id in both.
function callKey(item: LiveItem): string | null {
  const callId = parsePayload(item)?.call_id;
  if (typeof callId === 'string' && callId) return `call:${callId}`;
  return item.source_item_id ? `source:${item.source_item_id}` : null;
}

/**
 * Fold each tool result into the earlier tool call it answers, so a call and its
 * outcome read as one row. A result whose call is not in the loaded window, or a
 * second result for the same call, stays a row of its own.
 */
export function buildLiveStreamRows(items: readonly LiveItem[]): LiveStreamRow[] {
  const rows: LiveStreamRow[] = [];
  const openCalls = new Map<string, LiveStreamRow>();
  for (const item of items) {
    const key = callKey(item);
    if (item.kind === 'tool_result' && key) {
      const call = openCalls.get(key);
      if (call && call.item.session_id === item.session_id) {
        call.result = item;
        openCalls.delete(key);
        continue;
      }
    }
    const row: LiveStreamRow = { item, result: null };
    rows.push(row);
    if (item.kind === 'tool_call' && key) openCalls.set(key, row);
  }
  return rows;
}

/** The result folded into this call's row, if the loaded items hold one. */
export function pairedToolResult(items: readonly LiveItem[], item: LiveItem | null): LiveItem | null {
  if (!item || item.kind !== 'tool_call') return null;
  return buildLiveStreamRows(items).find(row => row.item.id === item.id)?.result ?? null;
}

const FAILED_STATUSES = new Set(['error', 'failed', 'failure', 'timeout', 'denied']);

function itemFailed(item: LiveItem | null): boolean {
  if (!item) return false;
  if (item.status && FAILED_STATUSES.has(item.status.toLowerCase())) return true;
  const payload = parsePayload(item);
  return payload?.is_error === true || payload?.success === false;
}

/** Whether the call or its result failed. */
export function rowFailed(row: LiveStreamRow): boolean {
  return itemFailed(row.item) || itemFailed(row.result);
}

function findText(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') return value.trim() ? value.trim() : null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = findText(entry, depth + 1);
      if (text) return text;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['summary', 'text', 'content', 'output', 'result_content', 'message', 'title', 'label']) {
      const text = findText((value as Record<string, unknown>)[key], depth + 1);
      if (text) return text;
    }
  }
  return null;
}

function toolName(payload: Record<string, unknown> | null): string | null {
  const name = payload?.tool_name ?? payload?.name;
  return typeof name === 'string' && name && name !== 'unknown' ? name : null;
}

const ARGUMENT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill'];

/** The argument that says what a tool call did: its command, file, pattern or query. */
export function toolArgument(item: LiveItem): string | null {
  const payload = parsePayload(item);
  const raw = payload?.input ?? payload?.arguments;
  let input: unknown = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      return raw.trim() || null;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.redacted === true) return null;
  for (const key of ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.every(part => typeof part === 'string') && value.length > 0) return value.join(' ');
  }
  return null;
}

// Claude Code records local slash commands as tagged user text: a caveat, the
// command, then its output.
function localCommand(item: LiveItem, payload: Record<string, unknown> | null) {
  if (item.kind !== 'user_message' || typeof payload?.text !== 'string') return null;
  const parsed = parseSessionText(payload.text);
  return parsed && parsed.kind !== 'plain' ? parsed : null;
}

/** The short label at the start of a row. */
export function rowLabel(item: LiveItem): string {
  const payload = parsePayload(item);
  switch (item.kind) {
    case 'user_message': {
      const local = localCommand(item, payload);
      if (local?.kind === 'command') return 'Command';
      if (local?.kind === 'output') return local.stream === 'stderr' ? 'Command error' : 'Command output';
      if (local?.kind === 'caveat') return 'Command note';
      return 'You';
    }
    case 'assistant_message':
      return payload?.summary === 'Model response' ? 'Model response' : 'Assistant';
    case 'reasoning':
      return 'Thinking';
    case 'tool_call':
    case 'tool_result':
      return toolName(payload) ?? (item.kind === 'tool_call' ? 'Tool call' : 'Tool result');
    case 'plan_update':
      return 'Plan';
    case 'status_change': {
      const event = typeof payload?.event_type === 'string' ? payload.event_type : item.status;
      return event ? event.replaceAll('_', ' ') : 'Status';
    }
    default:
      return item.kind.replaceAll('_', ' ');
  }
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** The text under a row's label: the message, the thought, or the tool's result. */
export function rowBody(row: LiveStreamRow): string | null {
  const payload = parsePayload(row.item);
  if (payload?.redacted === true) return 'Redacted by capture settings';
  switch (row.item.kind) {
    case 'user_message': {
      const local = localCommand(row.item, payload);
      if (local?.kind === 'command') return [local.name || local.message, local.args].filter(Boolean).join(' ');
      if (local?.kind === 'output') return local.text || '(no output)';
      if (local?.kind === 'caveat') return null;
      return findText(payload);
    }
    case 'tool_call': {
      if (!row.result) return null;
      const result = parsePayload(row.result);
      return findText(result) ?? null;
    }
    case 'tool_result':
      return findText(payload);
    case 'plan_update':
      return Array.isArray(payload?.steps) ? `${payload.steps.length} planned step${payload.steps.length === 1 ? '' : 's'}` : findText(payload);
    case 'assistant_message':
      if (payload?.summary === 'Model response') {
        const parts = [typeof payload.model === 'string' ? payload.model : null];
        if (typeof payload.tokens_in === 'number') parts.push(`${compactCount(payload.tokens_in)} in`);
        if (typeof payload.tokens_out === 'number') parts.push(`${compactCount(payload.tokens_out)} out`);
        const text = parts.filter(Boolean).join(' · ');
        return text || null;
      }
      return findText(payload);
    case 'status_change':
      return null;
    default:
      return findText(payload);
  }
}
