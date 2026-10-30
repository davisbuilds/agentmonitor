import path from 'path';
import type { ContentBlock, ParsedChunk, ParsedSession, ParsedMessage, ParsedToolCall, ParsedToolReceipt } from './claude-code.js';
import { config } from '../config.js';
import { findSubagentBoundary } from './codex-subagent-boundary.js';
import { codexSubagentTitle, promptTitleFromTexts } from './session-title.js';
import { codexInvocationMode } from '../util/invocation-mode.js';
import {
  parseCodexCatalogPresentations,
  projectIdentityFromCwd,
  type SessionContextObservation,
} from '../skills/context-observations.js';
import {
  extractCodexCommandFromInputJson,
  extractCodexSkillNamesFromCommand,
  fingerprintCodexCommand,
} from '../skills/invocation-detection.js';
import { projectNameFromCwd } from '../util/project-identity.js';

// --- Codex JSONL line types ---

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    originator?: string;
    timestamp?: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    name?: string;
    input?: string;
    arguments?: string;
    type?: string;
    // event_msg / token_count telemetry
    info?: {
      last_token_usage?: CodexTokenUsage;
      total_token_usage?: CodexTokenUsage;
      model_context_window?: number;
    } | null;
    [key: string]: unknown;
  };
}

function categorizeCodexToolName(toolName: string): string {
  switch (toolName) {
    case 'exec_command':
    case 'shell_command':
      return 'Bash';
    case 'apply_patch':
      return 'Edit';
    default:
      return 'Other';
  }
}

function parseToolInput(payload: CodexLine['payload']): unknown {
  if (!payload) return null;

  if (typeof payload.input === 'string' && payload.input.length > 0) {
    return payload.input;
  }

  if (typeof payload.arguments === 'string' && payload.arguments.length > 0) {
    try {
      return JSON.parse(payload.arguments);
    } catch {
      return payload.arguments;
    }
  }

  return null;
}

function extractTextBlock(block: { type: string; text?: string }): string | null {
  if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
    && typeof block.text === 'string'
    && block.text.trim()) {
    return block.text;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseItemText(payload: Record<string, unknown>): string {
  const content = payload['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      const block = asRecord(item);
      const text = block?.['text'];
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('');
}

/** Longest tool-output preview a receipt keeps, in characters. */
const TOOL_OUTPUT_PREVIEW_CHARS = 2_000;
/** Calls kept waiting for an output across continued parses; older ones are given up. */
const OPEN_CALL_LIMIT = 1_000;

/** A tool output's text: a plain string, or the text of its content parts. */
function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output
    .map(part => {
      const block = asRecord(part);
      return typeof block?.['text'] === 'string' ? block['text'] : '';
    })
    .join('');
}

// --- Parse Codex JSONL content into ParsedSession ---

/** What a Codex parse carries forward; see ClaudeParseState. */
export interface CodexParseState {
  messageCount: number;
  sourceOrdinal: number;
  firstUserMessage: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  userMessageCount: number;
  cwd: string | null;
  latestCwd: string | null;
  originator?: string;
  parentSessionId: string | null;
  relationshipType: string | null;
  harnessVersion: string | null;
  initialModel: string | null;
  initialContextWindowReported?: number;
  latestModel: string | null;
  contextUsedTokens?: number;
  contextWindowReported?: number;
  malformedRecords: number;
  sawInstructionWorldState: boolean;
  sawCatalogPresentation: boolean;
  /** Calls still waiting for their output, by call id, with their message ordinal. */
  openCalls?: Record<string, number>;
}

export interface CodexParseOptions {
  /** Keep a bounded preview of each tool output. Defaults to the live tool-argument capture setting. */
  captureToolOutput?: boolean;
}

export function parseCodexSessionMessages(
  jsonlContent: string,
  sessionId: string,
  filePath?: string,
  options?: CodexParseOptions,
): ParsedSession {
  return parseCodexSessionChunk(jsonlContent, sessionId, filePath, undefined, options).parsed;
}

/**
 * Parse Codex rollout lines, continuing from `state` when given (see
 * ParsedChunk). A parse is not resumable while a later line could still change
 * what it produced: before the session_meta line, while a subagent's own first
 * turn is still unseen, or after a catalog presentation recorded a model or
 * context window that only a later line would supply.
 */
export function parseCodexSessionChunk(
  jsonlContent: string,
  sessionId: string,
  filePath?: string,
  state?: CodexParseState,
  options?: CodexParseOptions,
): ParsedChunk<CodexParseState> {
  const messages: ParsedMessage[] = [];
  const toolCalls: ParsedToolCall[] = [];
  const receipts: ParsedToolReceipt[] = [];
  const captureToolOutput = options?.captureToolOutput ?? config.live.capture.toolArguments;
  // A call waits here for its output: by message index when its message is in
  // this parse, by stored ordinal when an earlier parse stored it.
  const openCalls = new Map<string, number>(Object.entries(state?.openCalls ?? {}));
  const chunkCalls = new Map<string, number>();
  const ordinalBase = state?.messageCount ?? 0;
  let firstUserMessage: string | null = state?.firstUserMessage ?? null;
  let title: string | null = state?.title ?? null;
  let startedAt: string | null = state?.startedAt ?? null;
  let endedAt: string | null = state?.endedAt ?? null;
  let userMessageCount = state?.userMessageCount ?? 0;
  let cwd: string | null = state?.cwd ?? null;
  let originator: string | undefined = state?.originator;
  let parentSessionId: string | null = state?.parentSessionId ?? null;
  let relationshipType: string | null = state?.relationshipType ?? null;
  let harnessVersion: string | null = state?.harnessVersion ?? null;
  let initialModel: string | null = state?.initialModel ?? null;
  let initialContextWindowReported: number | undefined = state?.initialContextWindowReported;
  let latestModel: string | null = state?.latestModel ?? null;
  // Latest context-window occupancy from token_count telemetry (in file order).
  // Numerator is last_token_usage.input_tokens, which is cache-inclusive.
  let contextUsedTokens: number | undefined = state?.contextUsedTokens;
  let contextWindowReported: number | undefined = state?.contextWindowReported;
  let malformedRecords = state?.malformedRecords ?? 0;
  let sawInstructionWorldState = state?.sawInstructionWorldState ?? false;
  let resumable = true;
  const contextObservations: SessionContextObservation[] = [];

  const lines: Array<{ line: CodexLine; ordinal: number }> = [];
  let sourceOrdinal = state?.sourceOrdinal ?? 0;
  for (const raw of jsonlContent.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push({ line: JSON.parse(trimmed) as CodexLine, ordinal: sourceOrdinal });
    } catch {
      malformedRecords++;
    }
    sourceOrdinal++;
  }

  // A spawned subagent's rollout can open with a copy of the parent's turns,
  // which the parent session already shows. Browse the child from its own first
  // turn, keeping only the instruction preamble written before the copy. Only
  // inherited activity (a turn or a request) proves a copy: a compaction with
  // neither after it, before the child's first surviving turn, is the child's
  // own earlier work.
  // A continued parse starts after both, so neither is looked for again.
  if (!state) {
    const boundary = findSubagentBoundary(lines.map(entry => entry.line));
    if (boundary.kind === 'unresolved') resumable = false;
    if (boundary.kind === 'resolved') {
      const preBoundary = lines.slice(0, boundary.line);
      const copyStart = preBoundary.findIndex(entry =>
        entry.line.type === 'turn_context' || entry.line.type === 'compacted');
      const inherited = copyStart >= 0 && preBoundary.slice(copyStart).some(entry =>
        entry.line.type === 'turn_context'
        || (entry.line.type === 'event_msg' && entry.line.payload?.type === 'token_count'));
      if (inherited) lines.splice(copyStart, boundary.line - copyStart);
    }
    if (!lines.some(({ line }) => line.type === 'session_meta' && line.payload)) resumable = false;
  }

  // Extract session metadata
  for (const { line } of state ? [] : lines) {
    if (line.type === 'session_meta' && line.payload) {
      cwd = (line.payload.cwd as string) ?? null;
      startedAt = line.payload.timestamp ?? line.timestamp ?? null;
      endedAt = startedAt;
      originator = line.payload.originator;
      const source = line.payload['source'];
      const subagent = asRecord(source)?.['subagent'];
      const spawn = asRecord(asRecord(subagent)?.['thread_spawn']);
      const parent = spawn?.['parent_thread_id'] ?? line.payload['parent_thread_id'];
      if (spawn || line.payload['thread_source'] === 'subagent') {
        relationshipType = 'subagent';
        parentSessionId = typeof parent === 'string' && parent ? parent : null;
        title = codexSubagentTitle(spawn?.['agent_path']);
      } else if (typeof subagent === 'string'
        && ['compact', 'memory_consolidation', 'memory_extraction'].includes(subagent)) {
        relationshipType = 'internal';
      } else if (asRecord(subagent)?.['other'] === 'guardian' || line.payload['thread_source'] === 'guardian_review') {
        // An approval review: Codex's own thread, though it names the thread it reviews as parent.
        relationshipType = 'internal';
      } else if (typeof source === 'string' && ['cli', 'vscode', 'exec'].includes(source)) {
        relationshipType = 'conversation';
      }
      harnessVersion = typeof line.payload['cli_version'] === 'string'
        ? line.payload['cli_version']
        : null;
      break;
    }
  }
  for (const { line } of lines) {
    if (
      initialModel === null
      && line.type === 'turn_context'
      && typeof line.payload?.['model'] === 'string'
    ) {
      initialModel = line.payload['model'];
    }
    if (
      initialContextWindowReported === undefined
      && line.type === 'event_msg'
      && line.payload?.type === 'token_count'
      && typeof line.payload.info?.model_context_window === 'number'
    ) {
      initialContextWindowReported = line.payload.info.model_context_window;
    }
    if (initialModel !== null && initialContextWindowReported !== undefined) break;
  }

  let latestCwd = state ? state.latestCwd : cwd;
  const inspectContextPayload = (
    payload: Record<string, unknown>,
    ordinal: number,
    timestamp: string | null,
    source: string,
  ): void => {
    const payloadCwd = payload['cwd'];
    if (typeof payloadCwd === 'string' && payloadCwd.trim()) latestCwd = payloadCwd;
    const projectIdentity = projectIdentityFromCwd(latestCwd);
    const name = payload['name'];
    if (typeof name === 'string' && ['exec_command', 'exec'].includes(name)) {
      const input = typeof payload['input'] === 'string'
        ? payload['input']
        : typeof payload['arguments'] === 'string'
          ? payload['arguments']
          : null;
      const command = extractCodexCommandFromInputJson(input);
      if (command) {
        const commandFingerprint = fingerprintCodexCommand(command);
        for (const skillName of extractCodexSkillNamesFromCommand(command)) {
          contextObservations.push({
            ordinal,
            kind: 'consultation',
            source,
            timestamp,
            skillName,
            commandFingerprint,
            projectIdentity: projectIdentity ?? undefined,
          });
        }
      }
    }

    const text = responseItemText(payload);
    for (const presentation of parseCodexCatalogPresentations(text)) {
      // Falling back to an initial value no line has given yet: a later line
      // that gives one would change this observation.
      if ((latestModel ?? initialModel) === null
        || (contextWindowReported ?? initialContextWindowReported) === undefined) {
        resumable = false;
      }
      contextObservations.push({
        ordinal,
        kind: 'catalog_presentation',
        source,
        timestamp,
        projectIdentity: projectIdentity ?? undefined,
        metadata: {
          fingerprint: presentation.fingerprint,
          measurement: presentation.measurement,
          truncation: presentation.truncation,
          runtime: {
            harnessVersion,
            model: latestModel ?? initialModel,
            modelVersion: null,
            contextWindowIdentity: (contextWindowReported ?? initialContextWindowReported) === undefined
              ? null
              : `tokens:${contextWindowReported ?? initialContextWindowReported}`,
            representation: presentation.representation,
          },
        },
        catalogEntries: presentation.entries,
      });
    }
  };

  // Process response_item lines as messages
  for (const { line, ordinal } of lines) {
    const timestamp = line.timestamp ?? null;
    if (timestamp) {
      // Forks may retain older messages. The native creation timestamp wins;
      // inherited context is still browsable but must not backdate the thread.
      if (!startedAt) startedAt = timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }

    // Context-window occupancy: track the latest token_count telemetry. The
    // last request's input_tokens (cache-inclusive) is how full the window is;
    // total_token_usage is cumulative billing and must NOT be used here.
    if (line.type === 'event_msg' && line.payload?.type === 'token_count') {
      const info = line.payload.info;
      const lastUsage = info?.last_token_usage;
      if (lastUsage && typeof lastUsage.input_tokens === 'number') {
        contextUsedTokens = lastUsage.input_tokens;
      }
      if (typeof info?.model_context_window === 'number') {
        contextWindowReported = info.model_context_window;
      }
      continue;
    }

    if (line.type === 'turn_context' && typeof line.payload?.cwd === 'string') {
      latestCwd = line.payload.cwd;
    }
    if (line.type === 'turn_context' && typeof line.payload?.['model'] === 'string') {
      latestModel = line.payload['model'];
    }

    if (line.type === 'world_state' && line.payload) {
      const state = asRecord(line.payload['state']);
      if (state && Object.prototype.hasOwnProperty.call(state, 'agents_md')) {
        sawInstructionWorldState = true;
        const rawAgents = state['agents_md'];
        const agents = Array.isArray(rawAgents) ? rawAgents : [rawAgents];
        for (const rawAgent of agents) {
          const agent = asRecord(rawAgent);
          const directory = agent?.['directory'];
          if (typeof directory !== 'string' || !directory.trim()) continue;
          contextObservations.push({
            ordinal: ordinal * 1000,
            kind: 'instruction_load',
            source: 'codex_world_state',
            timestamp,
            projectIdentity: projectIdentityFromCwd(latestCwd) ?? undefined,
            metadata: {
              file_path: path.join(directory, 'AGENTS.md'),
              memory_type: 'AGENTS.md',
            },
          });
        }
      }
      continue;
    }

    if (line.type === 'compacted') {
      contextObservations.push({
        ordinal: ordinal * 1000,
        kind: 'compaction',
        source: 'codex_compacted',
        timestamp,
        projectIdentity: projectIdentityFromCwd(latestCwd) ?? undefined,
      });
      const replacementHistory = line.payload?.['replacement_history'];
      if (Array.isArray(replacementHistory)) {
        replacementHistory.forEach((item, replacementIndex) => {
          const record = asRecord(item);
          const nestedPayload = asRecord(record?.['payload']) ?? record;
          if (nestedPayload) {
            inspectContextPayload(
              nestedPayload,
              ordinal * 1000 + replacementIndex + 1,
              typeof record?.['timestamp'] === 'string' ? record['timestamp'] : timestamp,
              'codex_replacement_history',
            );
          }
        });
      }
      continue;
    }

    if (line.type !== 'response_item' || !line.payload) continue;
    inspectContextPayload(
      line.payload as Record<string, unknown>,
      ordinal * 1000,
      timestamp,
      'codex_response_item',
    );

    const role = line.payload.role;
    const contentBlocks = line.payload.content;
    const toolName = line.payload.name;
    const toolInput = parseToolInput(line.payload);
    const callId = typeof line.payload['call_id'] === 'string' && line.payload['call_id'] ? line.payload['call_id'] : undefined;

    // A tool output: a receipt on its call's message, so no ordinal moves. An
    // output whose call this session never stored has nothing to attach to.
    if ((line.payload.type === 'function_call_output' || line.payload.type === 'custom_tool_call_output') && callId) {
      const text = toolOutputText(line.payload['output']);
      const receipt: ContentBlock = {
        type: 'tool_result',
        tool_use_id: callId,
        content: captureToolOutput ? text.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : '',
        ...(timestamp ? { timestamp } : {}),
        output_bytes: Buffer.byteLength(text, 'utf8'),
        // Codex links no exit code or success flag to a call.
        outcome: 'unrecorded',
      };
      const index = chunkCalls.get(callId);
      if (index !== undefined) {
        const message = messages[index];
        const withReceipt = [...(JSON.parse(message.content) as ContentBlock[]), receipt];
        message.content = JSON.stringify(withReceipt);
        message.content_length = message.content.length;
        chunkCalls.delete(callId);
      } else if (openCalls.has(callId)) {
        receipts.push({ ordinal: openCalls.get(callId)!, block: receipt });
      }
      openCalls.delete(callId);
      continue;
    }

    // Tool call response_item (no role, has name + input)
    if (toolName && !role) {
      const blocks: ContentBlock[] = [{
        type: 'tool_use',
        ...(callId ? { id: callId } : {}),
        name: toolName,
        input: toolInput,
      }];

      toolCalls.push({
        session_id: sessionId,
        tool_name: toolName,
        category: categorizeCodexToolName(toolName),
        tool_use_id: callId ?? null,
        input_json: toolInput != null ? JSON.stringify(toolInput) : null,
        subagent_session_id: null,
        message_ordinal: ordinalBase + messages.length,
      });
      if (callId) {
        chunkCalls.set(callId, messages.length);
        openCalls.set(callId, ordinalBase + messages.length);
      }

      const contentJson = JSON.stringify(blocks);
      messages.push({
        session_id: sessionId,
        ordinal: ordinalBase + messages.length,
        role: 'assistant',
        content: contentJson,
        timestamp,
        has_thinking: 0,
        has_tool_use: 1,
        content_length: contentJson.length,
      });
      continue;
    }

    // Regular message with role + content
    if (!role || !Array.isArray(contentBlocks)) continue;

    const blocks: ContentBlock[] = [];
    for (const block of contentBlocks) {
      const text = extractTextBlock(block);
      if (text) {
        blocks.push({ type: 'text', text });
      }
    }

    if (blocks.length === 0) continue;

    const contentJson = JSON.stringify(blocks);

    if (role === 'user') {
      userMessageCount++;
      firstUserMessage ??= promptTitleFromTexts(blocks.flatMap(block => block.text ? [block.text] : []));
    }

    messages.push({
      session_id: sessionId,
      ordinal: ordinalBase + messages.length,
      role,
      content: contentJson,
      timestamp,
      has_thinking: 0,
      has_tool_use: 0,
      content_length: contentJson.length,
    });
  }

  // A recorded cwd decides, even when it names no project (scratch work).
  const project = cwd ? projectNameFromCwd(cwd) : (filePath ? projectFromCodexPath(filePath) : null);
  const sawCatalogPresentation = (state?.sawCatalogPresentation ?? false)
    || contextObservations.some(observation => observation.kind === 'catalog_presentation');

  const parsed: ParsedSession = {
    messages,
    toolCalls,
    ...(receipts.length > 0 ? { receipts } : {}),
    metadata: {
      session_id: sessionId,
      project,
      agent: 'codex',
      first_message: firstUserMessage,
      cwd,
      title,
      started_at: startedAt,
      ended_at: endedAt,
      message_count: ordinalBase + messages.length,
      user_message_count: userMessageCount,
      parent_session_id: parentSessionId,
      relationship_type: relationshipType,
      mode: codexInvocationMode(originator),
      context_used_tokens: contextUsedTokens,
      context_window_reported: contextWindowReported,
    },
    skillContext: {
      projectIdentity: projectIdentityFromCwd(latestCwd),
      observations: contextObservations.sort((left, right) => left.ordinal - right.ordinal),
      capabilities: {
        orderedConsultations: malformedRecords === 0
          ? { observable: true }
          : { observable: false, reason: 'malformed_source_record' },
        compactionVisibility: malformedRecords === 0
          ? { observable: true }
          : { observable: false, reason: 'malformed_source_record' },
        catalogPresentation: sawCatalogPresentation
          ? { observable: true }
          : { observable: false, reason: 'presentation_signal_absent' },
        instructionLoads: sawInstructionWorldState
          ? { observable: true }
          : {
              observable: false,
              reason: 'instruction_load_signal_absent',
            },
        diagnostics: malformedRecords > 0 ? ['malformed_source_record'] : [],
      },
    },
  };
  return {
    parsed,
    state: {
      messageCount: ordinalBase + messages.length,
      sourceOrdinal,
      firstUserMessage,
      title,
      startedAt,
      endedAt,
      userMessageCount,
      cwd,
      latestCwd,
      originator,
      parentSessionId,
      relationshipType,
      harnessVersion,
      initialModel,
      initialContextWindowReported,
      latestModel,
      contextUsedTokens,
      contextWindowReported,
      malformedRecords,
      sawInstructionWorldState,
      sawCatalogPresentation,
      openCalls: Object.fromEntries([...openCalls].slice(-OPEN_CALL_LIMIT)),
    },
    resumable,
  };
}

function projectFromCodexPath(_filePath: string): string | null {
  return null;
}
