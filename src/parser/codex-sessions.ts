import type { ContentBlock, ParsedChunk, ParsedSession, ParsedMessage, ParsedToolCall, ParsedToolReceipt } from './claude-code.js';
import { config } from '../config.js';
import { findSubagentBoundary } from './codex-subagent-boundary.js';
import { codexSubagentTitle, promptTitleFromTexts } from './session-title.js';
import { codexInvocationMode } from '../util/invocation-mode.js';
import { projectIdentityFromCwd } from '../skills/context-observations.js';
import { CODEX_CONTEXT_EVIDENCE_VERSION } from '../skills/codex-evidence-version.js';
import { codexRecord as asRecord } from '../skills/codex-catalog.js';
import { CodexContextParser, type CodexContextParseState } from './codex-context.js';
import {
  extractCodexCommandFromInputJson,
  extractCodexSkillNamesFromCommand,
  fingerprintCodexCommand,
} from '../skills/invocation-detection.js';
import { projectNameFromCwd } from '../util/project-identity.js';

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

function extractTextBlock(value: unknown): string | null {
  const block = asRecord(value);
  const type = block?.['type'];
  const text = block?.['text'];
  return (type === 'text' || type === 'input_text' || type === 'output_text')
    && typeof text === 'string' && text.trim() ? text : null;
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
  contextUsedTokens?: number;
  contextWindowReported?: number;
  malformedRecords: number;
  contextEvidence: CodexContextParseState;
  /** Calls still waiting for their output, by call id, with their message ordinal. */
  openCalls?: Record<string, number>;
}

export interface CodexParseOptions {
  /** Keep a bounded preview of each tool output. Defaults to the live tool-argument capture setting. */
  captureToolOutput?: boolean;
  inheritedThroughOrdinal?: number;
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
  // WHY: Continuation output can belong to a call stored by an earlier parse.
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
  let contextUsedTokens: number | undefined = state?.contextUsedTokens;
  let contextWindowReported: number | undefined = state?.contextWindowReported;
  let malformedRecords = state?.malformedRecords ?? 0;
  let resumable = true;
  const contextEvidence = new CodexContextParser(state?.contextEvidence);

  const lines: Array<{ line: CodexLine; ordinal: number }> = [];
  let sourceOrdinal = state?.sourceOrdinal ?? 0;
  for (const raw of jsonlContent.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const line = asRecord(JSON.parse(trimmed));
      if (!line) throw new Error('invalid source record');
      lines.push({ line: line as CodexLine, ordinal: sourceOrdinal });
    } catch {
      malformedRecords++;
      lines.push({ line: { type: 'malformed_source_record' }, ordinal: sourceOrdinal });
    }
    sourceOrdinal++;
  }

  // WHY: A spawned subagent may begin with its parent's history, which is already visible in the
  // parent transcript.
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

  for (const { line } of state ? [] : lines) {
    if (line.type === 'session_meta' && line.payload) {
      cwd = typeof line.payload.cwd === 'string' ? line.payload.cwd : null;
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
  let latestCwd = state ? state.latestCwd : cwd;
  const inspectConsultations = (
    payload: Record<string, unknown>,
    ordinal: number,
    timestamp: string | null,
  ): void => {
    const payloadCwd = payload['cwd'];
    if (typeof payloadCwd === 'string' && payloadCwd.trim()) latestCwd = payloadCwd;
    const projectIdentity = projectIdentityFromCwd(latestCwd);
    const type = payload['type'];
    const name = payload['name'];
    if (!payload['role'] && (type === 'function_call' || type === 'custom_tool_call' || type === undefined)
      && typeof name === 'string' && ['exec_command', 'exec'].includes(name)) {
      const input = typeof payload['input'] === 'string'
        ? payload['input']
        : typeof payload['arguments'] === 'string'
          ? payload['arguments']
          : null;
      const command = extractCodexCommandFromInputJson(input);
      if (command) {
        const commandFingerprint = fingerprintCodexCommand(command);
        for (const skillName of extractCodexSkillNamesFromCommand(command)) {
          contextEvidence.emit({
            ordinal,
            kind: 'consultation',
            source: 'codex_response_item',
            timestamp,
            skillName,
            commandFingerprint,
            projectIdentity: projectIdentity ?? undefined,
          });
        }
      }
    }

  };

  for (const [index, { line, ordinal }] of lines.entries()) {
    contextEvidence.inspect(line, ordinal * 1000, latestCwd,
      ordinal <= (options?.inheritedThroughOrdinal ?? -1), lines[index + 1]?.line);
    const timestamp = line.timestamp ?? null;
    if (timestamp) {
      // WHY: A fork's inherited messages can predate its own creation; they cannot establish the
      // child's start time.
      if (!startedAt) startedAt = timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }

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
    if (line.type !== 'response_item' || !line.payload) continue;
    inspectConsultations(line.payload as Record<string, unknown>, ordinal * 1000, timestamp);

    const role = line.payload.role;
    const contentBlocks = line.payload.content;
    const toolName = line.payload.name;
    const toolInput = parseToolInput(line.payload);
    const callId = typeof line.payload['call_id'] === 'string' && line.payload['call_id'] ? line.payload['call_id'] : undefined;

    if ((line.payload.type === 'function_call_output' || line.payload.type === 'custom_tool_call_output') && callId) {
      const text = toolOutputText(line.payload['output']);
      const receipt: ContentBlock = {
        type: 'tool_result',
        tool_use_id: callId,
        content: captureToolOutput ? text.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : '',
        ...(timestamp ? { timestamp } : {}),
        output_bytes: Buffer.byteLength(text, 'utf8'),
        // WHY: Codex does not attach a trustworthy exit code to every tool result.
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

  const project = cwd ? projectNameFromCwd(cwd) : (filePath ? projectFromCodexPath(filePath) : null);
  contextEvidence.finish();
  const evidence = contextEvidence.state;
  const catalogSources = [...evidence.catalogSources.values()].map(({ state }) => state);
  const catalogReason = catalogSources.find(source => source.status === 'unknown')?.reason ?? 'presentation_signal_absent';
  const coverageReason = malformedRecords > 0 ? 'malformed_source_record'
    : evidence.diagnostics.has('context_history_limit') ? 'context_history_limit' : null;

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
      observations: contextEvidence.observations.sort((left, right) => left.ordinal - right.ordinal),
      capabilities: {
        orderedConsultations: coverageReason
          ? { observable: false, reason: coverageReason } : { observable: true },
        compactionVisibility: coverageReason
          ? { observable: false, reason: coverageReason } : { observable: true },
        catalogPresentation: evidence.hasPresentation
          ? { observable: true } : { observable: false, reason: catalogReason },
        instructionLoads: evidence.hasInstructionObservation
          ? { observable: true }
          : evidence.instructionCoverage ?? { observable: false, reason: 'instruction_load_signal_absent' },
        diagnostics: [...new Set([...(coverageReason ? [coverageReason] : []), ...evidence.diagnostics])],
        codexEvidenceVersion: CODEX_CONTEXT_EVIDENCE_VERSION,
        codexCatalogSources: catalogSources,
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
      contextUsedTokens,
      contextWindowReported,
      malformedRecords,
      contextEvidence: evidence,
      openCalls: Object.fromEntries([...openCalls].slice(-OPEN_CALL_LIMIT)),
    },
    resumable: resumable && contextEvidence.resumable,
  };
}

function projectFromCodexPath(_filePath: string): string | null {
  return null;
}
