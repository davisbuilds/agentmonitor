import fs from 'node:fs';
import path from 'node:path';
import type { AntigravityChatToolCall } from '../import/antigravity/proto.js';
import {
  projectIdentityFromCwd,
  type SessionContextObservation,
} from '../skills/context-observations.js';
import {
  extractAntigravitySkillNamesFromToolCall,
  fingerprintAntigravitySkillCall,
  hasAntigravityNonZeroExit,
  isAntigravityShellTool,
} from '../skills/invocation-detection.js';
import { stripInlineImages } from '../util/inline-images.js';
import { categorizeToolName, type ContentBlock, type ParsedMessage, type ParsedToolCall } from './claude-code.js';
import { promptTitleFromTexts } from './session-title.js';

interface AntigravityToolCallEntry {
  id?: unknown;
  tool_call_id?: unknown;
  call_id?: unknown;
  name?: unknown;
  args?: unknown;
}

interface AntigravityTranscriptEntry {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  cache_read_tokens?: unknown;
  output_tokens?: unknown;
  thinking?: unknown;
  content?: unknown;
  error?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  call_id?: unknown;
  conversationId?: unknown;
  conversation_id?: unknown;
  subagent_conversation_id?: unknown;
  truncated_fields?: unknown;
}

export interface AntigravityStepToolEvidence {
  plannerToolCalls?: AntigravityChatToolCall[];
  stepToolCall?: AntigravityChatToolCall;
}

export interface AntigravityTranscriptParseOptions {
  stepCorrelation?: ReadonlyMap<number, AntigravityStepToolEvidence>;
  cwd?: string | null;
  extraSkillRoots?: readonly string[];
}

export interface AntigravityTranscriptResult {
  messages: ParsedMessage[];
  toolCalls: ParsedToolCall[];
  firstUserMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  userMessageCount: number;
  hasTruncatedFields: boolean;
  maxStepIndex: number | null;
  latestModel?: string;
  contextUsedTokens?: number;
  contextObservations: SessionContextObservation[];
  malformedRecords: number;
}

interface PendingToolCall {
  id: string;
  nativeId?: string;
  name: string;
  toolCallIndex: number;
  inputJson: string | null;
  timestamp: string | null;
  observationOrdinal: number;
}

const ANTIGRAVITY_CATEGORY_MAP: Record<string, string> = {
  read_file: 'Read',
  view_file: 'Read',
  view_file_outline: 'Read',
  view_code_item: 'Read',
  view_content_chunk: 'Read',
  list_dir: 'Read',
  list_directory: 'Read',
  list_resources: 'Read',
  read_resource: 'Read',
  read_notebook: 'Read',
  read_terminal: 'Read',
  write_file: 'Write',
  write_to_file: 'Write',
  write_blob: 'Write',
  edit_file: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  edit_notebook: 'Edit',
  file_change: 'Edit',
  propose_code: 'Edit',
  code_action: 'Edit',
  grep_search: 'Search',
  code_search: 'Search',
  internal_search: 'Search',
  find_by_name: 'Search',
  find: 'Search',
  find_all_references: 'Search',
  search_web: 'Search',
  web_search: 'Search',
  read_url_content: 'Search',
  search_knowledge_base: 'Search',
  lookup_knowledge_base: 'Search',
  trajectory_search: 'Search',
  run_command: 'Bash',
  command_status: 'Bash',
  send_command_input: 'Bash',
  shell_exec: 'Bash',
  execute_notebook: 'Bash',
  invoke_subagent: 'Agent',
  send_message: 'Agent',
  manage_subagents: 'Agent',
  define_subagent: 'Agent',
  manage_task: 'Agent',
  schedule: 'Agent',
  swarm: 'Agent',
  agency_tool_call: 'Agent',
  finish: 'Other',
};

const BOOKKEEPING_ENTRY_TYPES = new Set([
  'CONVERSATION_HISTORY',
  'EPHEMERAL_MESSAGE',
  'CHECKPOINT',
]);

const RESULT_TOOL_HINTS: Record<string, readonly string[]> = {
  LIST_DIRECTORY: ['list_dir', 'list_directory'],
  EDIT_FILE: ['edit_file', 'replace_file_content', 'multi_replace_file_content'],
  WRITE_FILE: ['write_file', 'write_to_file'],
};

function antigravityRootDir(conversationDbPath: string): string {
  let dir = path.dirname(conversationDbPath);
  while (path.dirname(dir) !== dir) {
    if (path.basename(dir) === 'conversations') {
      return path.dirname(dir);
    }
    dir = path.dirname(dir);
  }
  return path.dirname(path.dirname(conversationDbPath));
}

export function resolveAntigravityTranscriptPaths(
  conversationDbPath: string,
  sessionId = path.basename(conversationDbPath, '.db'),
): { fullPath: string; compactPath: string } {
  const logsDir = path.join(antigravityRootDir(conversationDbPath), 'brain', sessionId, '.system_generated', 'logs');
  return {
    fullPath: path.join(logsDir, 'transcript_full.jsonl'),
    compactPath: path.join(logsDir, 'transcript.jsonl'),
  };
}

function isReadableNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function resolveAntigravityTranscriptPath(
  conversationDbPath: string,
  sessionId = path.basename(conversationDbPath, '.db'),
): string {
  const { fullPath, compactPath } = resolveAntigravityTranscriptPaths(conversationDbPath, sessionId);
  if (isReadableNonEmptyFile(fullPath)) return fullPath;
  if (isReadableNonEmptyFile(compactPath)) return compactPath;
  return fullPath;
}

function stripTaggedBlocks(text: string, openTag: string, closeTag: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const openIdx = text.indexOf(openTag, cursor);
    if (openIdx === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, openIdx);
    const closeIdx = text.indexOf(closeTag, openIdx + openTag.length);
    if (closeIdx === -1) break;
    cursor = closeIdx + closeTag.length;
  }
  return out;
}

function isAtLineStart(text: string, idx: number): boolean {
  return idx === 0 || text[idx - 1] === '\n';
}

function isLineBreakOrEnd(text: string, idx: number): boolean {
  return idx >= text.length || text[idx] === '\n' || text[idx] === '\r';
}

function findNextLineTag(
  text: string,
  tag: string,
  fromIndex: number,
  requireNewlineEnd: boolean,
): number {
  let cursor = fromIndex;
  while (cursor <= text.length - tag.length) {
    const idx = text.indexOf(tag, cursor);
    if (idx === -1) return -1;
    if (isAtLineStart(text, idx) && (!requireNewlineEnd || isLineBreakOrEnd(text, idx + tag.length))) {
      return idx;
    }
    cursor = idx + tag.length;
  }
  return -1;
}

export function extractAntigravityUserText(raw: string): string {
  const openTag = '<USER_REQUEST>';
  const closeTag = '</USER_REQUEST>';
  const openIdx = raw.indexOf(openTag);
  if (openIdx !== -1) {
    const start = openIdx + openTag.length;
    const closeIdx = raw.indexOf(closeTag, start);
    if (closeIdx !== -1) {
      return raw.slice(start, closeIdx).trim();
    }
    let unclosed = raw.slice(start);
    unclosed = stripTaggedBlocks(unclosed, '<ADDITIONAL_METADATA>', '</ADDITIONAL_METADATA>');
    unclosed = stripTaggedBlocks(unclosed, '<USER_SETTINGS_CHANGE>', '</USER_SETTINGS_CHANGE>');
    return unclosed.trim();
  }
  let cleaned = stripTaggedBlocks(raw, '<ADDITIONAL_METADATA>', '</ADDITIONAL_METADATA>');
  cleaned = stripTaggedBlocks(cleaned, '<USER_SETTINGS_CHANGE>', '</USER_SETTINGS_CHANGE>');
  return cleaned.trim();
}

export function extractAntigravitySystemText(raw: string): string {
  const openTag = '<SYSTEM_MESSAGE>';
  const closeTag = '</SYSTEM_MESSAGE>';

  const collectLineBlocks = (requireNewlineEnd: boolean): { blocks: string[]; matched: boolean } => {
    const blocks: string[] = [];
    let matched = false;
    let hasLineClose = true;
    let cursor = 0;
    while (cursor < raw.length) {
      const openIdx = findNextLineTag(raw, openTag, cursor, requireNewlineEnd);
      if (openIdx === -1) break;
      matched = true;
      const start = openIdx + openTag.length;
      let closeIdx = -1;
      if (hasLineClose) {
        closeIdx = findNextLineTag(raw, closeTag, start, requireNewlineEnd);
        if (closeIdx === -1) hasLineClose = false;
      }
      if (closeIdx === -1) {
        closeIdx = raw.indexOf(closeTag, start);
      }
      const chunk = (closeIdx === -1 ? raw.slice(start) : raw.slice(start, closeIdx)).trim();
      if (chunk) blocks.push(chunk);
      if (closeIdx === -1) break;
      cursor = closeIdx + closeTag.length;
    }
    return { blocks, matched };
  };

  for (const requireNewlineEnd of [true, false]) {
    const { blocks, matched } = collectLineBlocks(requireNewlineEnd);
    if (matched) return blocks.join('\n\n');
  }

  const inlineBlocks: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const closeIdx = raw.indexOf(closeTag, cursor);
    if (closeIdx === -1) break;
    const openIdx = raw.lastIndexOf(openTag, closeIdx);
    if (openIdx === -1 || openIdx < cursor) break;
    const chunk = raw.slice(openIdx + openTag.length, closeIdx).trim();
    if (chunk) inlineBlocks.push(chunk);
    cursor = closeIdx + closeTag.length;
  }
  if (inlineBlocks.length > 0) return inlineBlocks.join('\n\n');

  return raw.trim();
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractTruncatedFields(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
}

function appendTruncationNote(text: string, fields: readonly string[]): string {
  if (fields.length === 0) return text;
  const marker = `[truncated: ${fields.join(', ')}]`;
  return text ? `${text}\n${marker}` : marker;
}

export function categorizeAntigravityToolName(toolName: string): string {
  return ANTIGRAVITY_CATEGORY_MAP[toolName] ?? categorizeToolName(toolName);
}

function unwrapAntigravityToolArgs(args: unknown): unknown {
  if (args == null) return null;
  let value: unknown = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const unwrapped: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      try {
        unwrapped[key] = JSON.parse(raw);
      } catch {
        unwrapped[key] = raw;
      }
    } else {
      unwrapped[key] = raw;
    }
  }
  return unwrapped;
}

function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function formatToolResultContent(entry: AntigravityTranscriptEntry, truncatedFields: readonly string[]): string {
  const rawContent = typeof entry.content === 'string' ? entry.content : '';
  const rawError = typeof entry.error === 'string' ? entry.error.trim() : '';
  let combined = rawContent;
  if (rawError) {
    if (!rawContent.trim()) {
      combined = rawError;
    } else if (!rawContent.includes(rawError)) {
      combined = `${rawContent}\nError: ${rawError}`;
    }
  }
  return appendTruncationNote(combined, truncatedFields);
}

function entryMatchesToolName(entryType: string, toolName: string): boolean {
  const lowerType = entryType.toLowerCase();
  const lowerTool = toolName.toLowerCase();
  if (lowerType === lowerTool) return true;
  const hints = RESULT_TOOL_HINTS[entryType];
  return hints ? hints.includes(lowerTool) : false;
}

const SAFE_CONVERSATION_ID = /^[A-Za-z0-9._-]{4,128}$/;

function validChildConversationId(raw: unknown, parentSessionId: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === parentSessionId || !SAFE_CONVERSATION_ID.test(trimmed)) return null;
  return trimmed;
}

function extractSubagentConversationId(
  entry: AntigravityTranscriptEntry,
  resultText: string,
  parentSessionId: string,
): string | null {
  for (const direct of [entry.conversationId, entry.conversation_id, entry.subagent_conversation_id]) {
    const id = validChildConversationId(direct, parentSessionId);
    if (id) return id;
  }

  const braceIdx = resultText.indexOf('{');
  if (braceIdx === -1) return null;
  const candidate = resultText.slice(braceIdx);
  const closeIdx = candidate.lastIndexOf('}');
  if (closeIdx > 0) {
    try {
      const parsed = JSON.parse(candidate.slice(0, closeIdx + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const id = validChildConversationId(record['conversationId'] ?? record['conversation_id'], parentSessionId);
        if (id) return id;
      }
    } catch {
      // WHY: Truncated result text can still retain the leading conversationId field before cutoff.
    }
  }
  const match = /"conversation(?:Id|_id)"\s*:\s*"([A-Za-z0-9._-]{4,128})"/.exec(candidate);
  return match ? validChildConversationId(match[1], parentSessionId) : null;
}

function takeMatchingPendingCall(
  pending: PendingToolCall[],
  entry: AntigravityTranscriptEntry,
  entryType: string,
  sqliteStepCall?: AntigravityChatToolCall,
  consume = true,
): PendingToolCall | undefined {
  if (pending.length === 0) return undefined;

  const takeAt = (idx: number): PendingToolCall => (consume ? pending.splice(idx, 1)[0]! : pending[idx]!);

  const explicitCallId = asNonEmptyString(entry.tool_call_id)
    ?? asNonEmptyString(entry.call_id)
    ?? asNonEmptyString(sqliteStepCall?.id);
  if (explicitCallId) {
    const matchIdx = pending.findIndex(
      call => call.nativeId === explicitCallId || call.id === explicitCallId,
    );
    return matchIdx !== -1 ? takeAt(matchIdx) : undefined;
  }

  if (entryType && entryType !== 'GENERIC') {
    const matches: number[] = [];
    pending.forEach((call, index) => {
      if (entryMatchesToolName(entryType, call.name)) matches.push(index);
    });
    if (matches.length === 1) {
      return takeAt(matches[0]!);
    }
    return undefined;
  }

  if (pending.length === 1) {
    return takeAt(0);
  }
  return undefined;
}

export function parseAntigravityTranscript(
  transcriptPath: string,
  sessionId: string,
  options?: AntigravityTranscriptParseOptions,
): AntigravityTranscriptResult | null {
  let raw: string;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return null;
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const entriesByStepIndex = new Map<number, { entry: AntigravityTranscriptEntry; lineOrder: number }>();
  const unindexedEntries: Array<{ entry: AntigravityTranscriptEntry; lineOrder: number }> = [];
  let lineOrder = 0;
  let maxStepIndex: number | null = null;
  let malformedRecords = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entry = parsed as AntigravityTranscriptEntry;
        const item = { entry, lineOrder };
        lineOrder++;
        if (typeof entry.step_index === 'number' && Number.isFinite(entry.step_index)) {
          entriesByStepIndex.set(entry.step_index, item);
          if (maxStepIndex === null || entry.step_index > maxStepIndex) {
            maxStepIndex = entry.step_index;
          }
        } else {
          unindexedEntries.push(item);
        }
      } else {
        malformedRecords++;
      }
    } catch {
      malformedRecords++;
      // WHY: Skip partial or corrupt trailing lines during live writes.
    }
  }

  const parsedEntries = [...entriesByStepIndex.values(), ...unindexedEntries];
  if (parsedEntries.length === 0) return null;

  // WHY: Antigravity can flush step N+1 slightly before step N (e.g., FINISH before PLANNER_RESPONSE).
  parsedEntries.sort((a, b) => {
    const idxA = a.entry.step_index;
    const idxB = b.entry.step_index;
    const hasA = typeof idxA === 'number' && Number.isFinite(idxA);
    const hasB = typeof idxB === 'number' && Number.isFinite(idxB);
    if (hasA !== hasB) return hasA ? -1 : 1;
    if (hasA && hasB && idxA !== idxB) return (idxA as number) - (idxB as number);
    return a.lineOrder - b.lineOrder;
  });

  const messages: ParsedMessage[] = [];
  const toolCalls: ParsedToolCall[] = [];
  const pendingCalls: PendingToolCall[] = [];
  const contextObservations: SessionContextObservation[] = [];
  const projectIdentity = projectIdentityFromCwd(options?.cwd);
  let nextObservationOrdinal = 0;
  let firstUserMessage: string | null = null;
  let userMessageCount = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let hasTruncatedFields = false;
  let latestModel: string | undefined;
  let contextUsedTokens: number | undefined;

  const recordTimestamp = (ts: string | null) => {
    if (!ts) return;
    if (!startedAt || ts < startedAt) startedAt = ts;
    if (!endedAt || ts > endedAt) endedAt = ts;
  };

  for (const { entry, lineOrder: order } of parsedEntries) {
    const entryType = typeof entry.type === 'string' ? entry.type : '';
    const timestamp = normalizeTimestamp(entry.created_at);
    recordTimestamp(timestamp);

    if (entryType === 'CHECKPOINT') {
      contextObservations.push({
        ordinal: nextObservationOrdinal++,
        kind: 'compaction',
        source: 'antigravity_checkpoint',
        timestamp,
        projectIdentity: projectIdentity ?? undefined,
      });
      continue;
    }

    if (BOOKKEEPING_ENTRY_TYPES.has(entryType)) continue;

    const truncatedFields = extractTruncatedFields(entry.truncated_fields);
    if (truncatedFields.length > 0) hasTruncatedFields = true;

    if (entryType === 'USER_INPUT') {
      pendingCalls.length = 0;
      const rawText = typeof entry.content === 'string' ? extractAntigravityUserText(entry.content) : '';
      const text = appendTruncationNote(rawText, truncatedFields);
      if (!text) continue;
      const content = stripInlineImages(JSON.stringify([{ type: 'text', text } satisfies ContentBlock]));
      userMessageCount++;
      if (rawText) firstUserMessage ??= promptTitleFromTexts([rawText]);
      messages.push({
        session_id: sessionId,
        ordinal: messages.length,
        role: 'user',
        content,
        timestamp,
        has_thinking: 0,
        has_tool_use: 0,
        content_length: content.length,
      });
      continue;
    }

    if (entryType === 'SYSTEM_MESSAGE' || entryType === 'ERROR_MESSAGE') {
      if (entryType === 'ERROR_MESSAGE') pendingCalls.length = 0;
      const rawText = typeof entry.content === 'string' && entry.content.trim()
        ? entry.content
        : typeof entry.error === 'string'
          ? entry.error
          : '';
      const cleanText = entryType === 'SYSTEM_MESSAGE'
        ? extractAntigravitySystemText(rawText)
        : rawText.trim();
      const text = appendTruncationNote(cleanText, truncatedFields);
      if (!text) continue;
      const content = stripInlineImages(JSON.stringify([{ type: 'text', text } satisfies ContentBlock]));
      messages.push({
        session_id: sessionId,
        ordinal: messages.length,
        role: 'system',
        content,
        timestamp,
        has_thinking: 0,
        has_tool_use: 0,
        content_length: content.length,
      });
      continue;
    }

    if (entryType === 'PLANNER_RESPONSE') {
      pendingCalls.length = 0;
      if (typeof entry.model === 'string' && entry.model.trim()) {
        latestModel = entry.model.trim();
      }
      const inTokens = typeof entry.input_tokens === 'number' && Number.isFinite(entry.input_tokens) ? entry.input_tokens : 0;
      const cacheTokens = typeof entry.cache_read_tokens === 'number' && Number.isFinite(entry.cache_read_tokens) ? entry.cache_read_tokens : 0;
      if (inTokens + cacheTokens > 0) {
        contextUsedTokens = inTokens + cacheTokens;
      }

      const blocks: ContentBlock[] = [];
      let hasThinking = false;
      let hasToolUse = false;
      const annotatedTruncations = new Set<string>();

      if (typeof entry.thinking === 'string' && entry.thinking.trim()) {
        const thinkingFields = truncatedFields.includes('thinking') ? ['thinking'] : [];
        if (thinkingFields.length > 0) annotatedTruncations.add('thinking');
        blocks.push({ type: 'thinking', thinking: appendTruncationNote(entry.thinking, thinkingFields) });
        hasThinking = true;
      }

      const rawText = typeof entry.content === 'string' && entry.content.trim() ? entry.content : '';
      const remainingTruncations = truncatedFields.filter(field => !annotatedTruncations.has(field));
      if (rawText || remainingTruncations.length > 0) {
        blocks.push({ type: 'text', text: appendTruncationNote(rawText, remainingTruncations) });
      }

      const hasStepIndex = typeof entry.step_index === 'number' && Number.isFinite(entry.step_index);
      const callPrefix = hasStepIndex ? `antigravity:${entry.step_index as number}` : `antigravity:line:${order}`;
      const sqlitePlannerCalls = hasStepIndex
        ? options?.stepCorrelation?.get(entry.step_index as number)?.plannerToolCalls
        : undefined;
      const rawCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      const messageOrdinal = messages.length;
      rawCalls.forEach((rawCall, callIdx) => {
        if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) return;
        const call = rawCall as AntigravityToolCallEntry;
        const name = typeof call.name === 'string' ? call.name.trim() : '';
        if (!name) return;
        const sqliteCall = sqlitePlannerCalls?.[callIdx];
        const sqliteNativeId = sqliteCall && sqliteCall.name === name ? asNonEmptyString(sqliteCall.id) : undefined;
        const nativeId = asNonEmptyString(call.id)
          ?? asNonEmptyString(call.tool_call_id)
          ?? asNonEmptyString(call.call_id)
          ?? sqliteNativeId;
        const toolUseId = nativeId ?? `${callPrefix}:${callIdx}`;
        const input = unwrapAntigravityToolArgs(call.args);
        const inputJson = input != null ? stripInlineImages(JSON.stringify(input)) : null;
        blocks.push({
          type: 'tool_use',
          id: toolUseId,
          name,
          input,
        });
        hasToolUse = true;
        const toolCallIndex = toolCalls.length;
        const observationOrdinal = nextObservationOrdinal++;
        pendingCalls.push({
          id: toolUseId,
          nativeId,
          name,
          toolCallIndex,
          inputJson,
          timestamp,
          observationOrdinal,
        });
        toolCalls.push({
          session_id: sessionId,
          tool_name: name,
          category: categorizeAntigravityToolName(name),
          tool_use_id: toolUseId,
          input_json: inputJson,
          subagent_session_id: null,
          message_ordinal: messageOrdinal,
        });
      });

      if (blocks.length === 0) continue;
      const content = stripInlineImages(JSON.stringify(blocks));
      messages.push({
        session_id: sessionId,
        ordinal: messageOrdinal,
        role: 'assistant',
        content,
        timestamp,
        has_thinking: hasThinking ? 1 : 0,
        has_tool_use: hasToolUse ? 1 : 0,
        content_length: content.length,
      });
      continue;
    }

    const hasResultPayload =
      typeof entry.content === 'string'
      || (typeof entry.error === 'string' && entry.error.trim().length > 0)
      || truncatedFields.length > 0;
    if (!hasResultPayload) continue;

    const hasStepIndex = typeof entry.step_index === 'number' && Number.isFinite(entry.step_index);
    const sqliteStepCall = hasStepIndex
      ? options?.stepCorrelation?.get(entry.step_index as number)?.stepToolCall
      : undefined;
    const isRunning = entry.status === 'RUNNING';
    const hasEntryError = entry.status === 'ERROR' || Boolean(typeof entry.error === 'string' && entry.error.trim());
    const matchedCall = takeMatchingPendingCall(
      pendingCalls,
      entry,
      entryType,
      sqliteStepCall,
      !(isRunning && !hasEntryError),
    );
    const resultText = formatToolResultContent(entry, truncatedFields);
    const isShellFailure = Boolean(
      matchedCall
      && isAntigravityShellTool(matchedCall.name)
      && hasAntigravityNonZeroExit(resultText),
    );
    const isError = hasEntryError || isShellFailure;
    if (matchedCall && !isError && !isRunning) {
      if (matchedCall.name === 'invoke_subagent') {
        const childId = extractSubagentConversationId(entry, resultText, sessionId);
        if (childId) {
          const targetCall = toolCalls[matchedCall.toolCallIndex];
          if (targetCall) targetCall.subagent_session_id = childId;
        }
      }
      const skillNames = extractAntigravitySkillNamesFromToolCall(matchedCall.name, matchedCall.inputJson, {
        cwd: options?.cwd,
        extraRoots: options?.extraSkillRoots,
      });
      if (skillNames.length > 0) {
        const commandFingerprint = fingerprintAntigravitySkillCall(matchedCall.name, matchedCall.inputJson, {
          cwd: options?.cwd,
        });
        for (const skillName of skillNames) {
          contextObservations.push({
            ordinal: matchedCall.observationOrdinal,
            kind: 'consultation',
            source: 'antigravity_transcript',
            timestamp: matchedCall.timestamp ?? timestamp,
            skillName,
            commandFingerprint: commandFingerprint ?? undefined,
            projectIdentity: projectIdentity ?? undefined,
            metadata: {
              toolUseId: matchedCall.id,
              toolName: matchedCall.name,
            },
          });
        }
      }
    }
    const block: ContentBlock = {
      type: 'tool_result',
      ...(matchedCall ? { tool_use_id: matchedCall.id } : {}),
      content: resultText,
      is_error: isError,
      ...(isRunning && !isError ? { outcome: 'unrecorded' as const } : {}),
      ...(timestamp ? { timestamp } : {}),
    };
    const content = stripInlineImages(JSON.stringify([block]));
    messages.push({
      session_id: sessionId,
      ordinal: messages.length,
      role: 'user',
      content,
      timestamp,
      has_thinking: 0,
      has_tool_use: 0,
      content_length: content.length,
    });
  }

  if (messages.length === 0) return null;

  contextObservations.sort((left, right) => left.ordinal - right.ordinal);

  return {
    messages,
    toolCalls,
    firstUserMessage,
    startedAt,
    endedAt,
    userMessageCount,
    hasTruncatedFields,
    maxStepIndex,
    latestModel,
    contextUsedTokens,
    contextObservations,
    malformedRecords,
  };
}
