// The transcript record types amon knows, per source. A harness that starts
// writing a new type is otherwise silent: every parser skips what it does not
// recognize. `amon`'s ingestion probe tallies the types it finds against these
// lists, so a new one shows up as `unknown` instead of being lost.
//
// `read` maps each type to what consumes it; `knownUnused` to why it is
// skipped. A type belongs in exactly one of them.

export interface RecordTypeCatalog {
  read: Readonly<Record<string, string>>;
  knownUnused: Readonly<Record<string, string>>;
}

/** Claude Code transcripts, by the line's top-level `type`. */
export const CLAUDE_RECORD_TYPES: RecordTypeCatalog = {
  read: {
    user: 'session browser, import',
    assistant: 'session browser, import (usage and cost)',
    system: 'session browser (compaction boundaries)',
    'ai-title': 'session title',
    'cost-state': 'costs check-claude-sessions --transcripts',
    error: 'import (legacy event-style lines)',
    tool_use: 'import (legacy event-style lines)',
    tool_result: 'import (legacy event-style lines)',
  },
  knownUnused: {
    attachment: 'harness context attachments; no transcript or usage content amon shows',
    'last-prompt': 'harness UI state',
    'permission-mode': 'harness UI state',
    mode: 'harness UI state',
    'pr-link': 'harness UI state',
    'atis-latch': 'harness UI state',
    'queue-operation': 'harness input queue',
    'bridge-session': 'harness remote-session bookkeeping',
    'frame-link': 'harness UI state',
    'tools-used': 'harness UI state',
    'artifact-autoreact-ledger': 'harness artifact bookkeeping',
    'artifact-comment-monitor': 'harness artifact bookkeeping',
    'file-history-snapshot': 'harness undo history',
    'file-history-delta': 'harness undo history',
    'api-request': 'request system prompt and parameters; usage comes from assistant lines',
    'api-request-blob': 'request payload bodies',
    'api-request-shape': 'request shape digests',
  },
};

/**
 * Codex rollouts, by top-level `type`, and for `event_msg` and `response_item`
 * by `type/payload.type`. A `response_item` with a role but no payload type is
 * an older-format `message`.
 */
export const CODEX_RECORD_TYPES: RecordTypeCatalog = {
  read: {
    session_meta: 'session identity and lineage',
    turn_context: 'model, working directory, subagent boundary',
    'event_msg/token_count': 'import usage (cumulative counter), context occupancy',
    token_usage_record: 'import usage (compaction requests), thread total',
    compacted: 'compaction observations and billing',
    world_state: 'instruction-load observations',
    'response_item/message': 'session browser',
    'response_item/function_call': 'session browser tool calls, import file changes',
    'response_item/custom_tool_call': 'session browser tool calls, import file changes',
    'response_item/function_call_output': 'session browser tool-result receipts',
    'response_item/custom_tool_call_output': 'session browser tool-result receipts',
  },
  knownUnused: {
    'response_item/reasoning': 'encrypted; no summary text unless Codex reasoning summaries are enabled',
    'response_item/agent_message': 'inter-agent messages; not projected',
    'response_item/additional_tools': 'tool catalog presentation',
    inter_agent_communication_metadata: 'inter-agent routing metadata',
    'event_msg/item_completed': 'structured items; their ids do not link to call ids',
    'event_msg/thread_settings_applied': 'harness settings',
    'event_msg/task_started': 'turn lifecycle',
    'event_msg/task_complete': 'turn lifecycle',
    'event_msg/turn_aborted': 'turn lifecycle',
  },
};

export function claudeRecordKind(line: unknown): string | null {
  if (typeof line !== 'object' || line === null) return null;
  const type = (line as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

export function codexRecordKind(line: unknown): string | null {
  if (typeof line !== 'object' || line === null) return null;
  const { type, payload } = line as { type?: unknown; payload?: { type?: unknown; role?: unknown } };
  if (typeof type !== 'string') return null;
  if (type !== 'event_msg' && type !== 'response_item') return type;
  if (typeof payload?.type === 'string') return `${type}/${payload.type}`;
  return type === 'response_item' && typeof payload?.role === 'string' ? `${type}/message` : type;
}

export interface RecordTypeTally {
  lines: number;
  /** Lines that are not JSON, or carry no type. */
  untyped: number;
  read: Record<string, number>;
  known_unused: Record<string, number>;
  unknown: Record<string, number>;
}

export function emptyRecordTypeTally(): RecordTypeTally {
  return { lines: 0, untyped: 0, read: {}, known_unused: {}, unknown: {} };
}

/** Add one transcript's lines to `tally`, by the kind `kindOf` gives each. */
export function tallyRecordTypes(
  content: string,
  kindOf: (line: unknown) => string | null,
  catalog: RecordTypeCatalog,
  tally: RecordTypeTally,
): RecordTypeTally {
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    tally.lines++;
    let kind: string | null;
    try {
      kind = kindOf(JSON.parse(raw));
    } catch {
      kind = null;
    }
    if (kind === null) {
      tally.untyped++;
      continue;
    }
    const bucket = Object.hasOwn(catalog.read, kind) ? tally.read
      : Object.hasOwn(catalog.knownUnused, kind) ? tally.known_unused
        : tally.unknown;
    bucket[kind] = (bucket[kind] ?? 0) + 1;
  }
  return tally;
}
