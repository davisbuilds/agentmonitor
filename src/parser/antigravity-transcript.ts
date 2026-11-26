import fs from 'node:fs';
import path from 'node:path';
import { stripInlineImages } from '../util/inline-images.js';
import { categorizeToolName, type ContentBlock, type ParsedMessage, type ParsedToolCall } from './claude-code.js';
import { promptTitleFromTexts } from './session-title.js';

interface AntigravityToolCallEntry {
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
}

export interface AntigravityTranscriptResult {
  messages: ParsedMessage[];
  toolCalls: ParsedToolCall[];
  firstUserMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  userMessageCount: number;
  latestModel?: string;
  contextUsedTokens?: number;
}

const MAX_TOOL_RESULT_CHARS = 8_192;
const TRUNCATED_SUFFIX = '\n... (truncated)';

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

const RESULT_ENTRY_TYPES = new Set([
  'GENERIC',
  'VIEW_FILE',
  'READ_URL_CONTENT',
  'LIST_DIRECTORY',
  'FINISH',
]);

const RESULT_TOOL_HINTS: Record<string, readonly string[]> = {
  VIEW_FILE: ['view_file'],
  READ_URL_CONTENT: ['read_url_content'],
  LIST_DIRECTORY: ['list_dir', 'list_directory'],
  FINISH: ['finish'],
};

export function resolveAntigravityTranscriptPath(
  conversationDbPath: string,
  sessionId = path.basename(conversationDbPath, '.db'),
): string {
  let dir = path.dirname(conversationDbPath);
  let antigravityDir: string | undefined;
  while (path.dirname(dir) !== dir) {
    if (path.basename(dir) === 'conversations') {
      antigravityDir = path.dirname(dir);
      break;
    }
    dir = path.dirname(dir);
  }
  antigravityDir ??= path.dirname(path.dirname(conversationDbPath));
  return path.join(antigravityDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
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

function extractTaggedContent(raw: string, openTag: string, closeTag: string): string | null {
  const openIdx = raw.indexOf(openTag);
  if (openIdx === -1) return null;
  const start = openIdx + openTag.length;
  const closeIdx = raw.indexOf(closeTag, start);
  if (closeIdx === -1) return raw.slice(start);
  return raw.slice(start, closeIdx);
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

function extractAntigravitySystemText(raw: string): string {
  const inner = extractTaggedContent(raw, '<SYSTEM_MESSAGE>', '</SYSTEM_MESSAGE>');
  return (inner ?? raw).trim();
}

function categorizeAntigravityToolName(toolName: string): string {
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

function formatToolResultContent(entry: AntigravityTranscriptEntry): string {
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
  if (combined.length <= MAX_TOOL_RESULT_CHARS) return combined;
  return combined.slice(0, MAX_TOOL_RESULT_CHARS - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

function takeMatchingPendingCall(
  pending: Array<{ id: string; name: string }>,
  entryType: string,
): { id: string; name: string } | undefined {
  if (pending.length === 0) return undefined;
  const hinted = RESULT_TOOL_HINTS[entryType];
  if (hinted) {
    const matchIdx = pending.findIndex(call => hinted.includes(call.name));
    if (matchIdx !== -1) return pending.splice(matchIdx, 1)[0];
    if (pending.length === 1) return pending.shift();
    return undefined;
  }
  return pending.shift();
}

export function parseAntigravityTranscript(
  transcriptPath: string,
  sessionId: string,
): AntigravityTranscriptResult | null {
  let raw: string;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return null;
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const parsedEntries: Array<{ entry: AntigravityTranscriptEntry; lineOrder: number }> = [];
  let lineOrder = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedEntries.push({ entry: parsed as AntigravityTranscriptEntry, lineOrder });
        lineOrder++;
      }
    } catch {
      // WHY: Skip partial or corrupt trailing lines during live writes.
    }
  }

  if (parsedEntries.length === 0) return null;

  // WHY: Antigravity can flush step N+1 slightly before step N (e.g., FINISH before PLANNER_RESPONSE).
  parsedEntries.sort((a, b) => {
    const idxA = a.entry.step_index;
    const idxB = b.entry.step_index;
    if (typeof idxA === 'number' && Number.isFinite(idxA)
      && typeof idxB === 'number' && Number.isFinite(idxB)
      && idxA !== idxB) {
      return idxA - idxB;
    }
    return a.lineOrder - b.lineOrder;
  });

  const messages: ParsedMessage[] = [];
  const toolCalls: ParsedToolCall[] = [];
  const pendingCalls: Array<{ id: string; name: string }> = [];
  let firstUserMessage: string | null = null;
  let userMessageCount = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
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

    if (entryType === 'USER_INPUT') {
      pendingCalls.length = 0;
      const text = typeof entry.content === 'string' ? extractAntigravityUserText(entry.content) : '';
      if (!text) continue;
      const content = stripInlineImages(JSON.stringify([{ type: 'text', text } satisfies ContentBlock]));
      userMessageCount++;
      firstUserMessage ??= promptTitleFromTexts([text]);
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
      const text = entryType === 'SYSTEM_MESSAGE'
        ? extractAntigravitySystemText(rawText)
        : rawText.trim();
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

      if (typeof entry.thinking === 'string' && entry.thinking.trim()) {
        blocks.push({ type: 'thinking', thinking: entry.thinking });
        hasThinking = true;
      }
      if (typeof entry.content === 'string' && entry.content.trim()) {
        blocks.push({ type: 'text', text: entry.content });
      }

      const stepKey = typeof entry.step_index === 'number' && Number.isFinite(entry.step_index)
        ? entry.step_index
        : order;
      const rawCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      const messageOrdinal = messages.length;
      rawCalls.forEach((rawCall, callIdx) => {
        if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) return;
        const call = rawCall as AntigravityToolCallEntry;
        const name = typeof call.name === 'string' ? call.name.trim() : '';
        if (!name) return;
        const toolUseId = `antigravity:${stepKey}:${callIdx}`;
        const input = unwrapAntigravityToolArgs(call.args);
        blocks.push({
          type: 'tool_use',
          id: toolUseId,
          name,
          input,
        });
        hasToolUse = true;
        pendingCalls.push({ id: toolUseId, name });
        toolCalls.push({
          session_id: sessionId,
          tool_name: name,
          category: categorizeAntigravityToolName(name),
          tool_use_id: toolUseId,
          input_json: input != null ? stripInlineImages(JSON.stringify(input)) : null,
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

    if (RESULT_ENTRY_TYPES.has(entryType)) {
      const matchedCall = takeMatchingPendingCall(pendingCalls, entryType);
      const resultText = formatToolResultContent(entry);
      const isError = entry.status === 'ERROR' || Boolean(typeof entry.error === 'string' && entry.error.trim());
      const block: ContentBlock = {
        type: 'tool_result',
        ...(matchedCall ? { tool_use_id: matchedCall.id } : {}),
        content: resultText,
        is_error: isError,
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
  }

  if (messages.length === 0) return null;

  return {
    messages,
    toolCalls,
    firstUserMessage,
    startedAt,
    endedAt,
    userMessageCount,
    latestModel,
    contextUsedTokens,
  };
}
