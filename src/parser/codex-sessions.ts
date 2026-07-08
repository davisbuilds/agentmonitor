import path from 'path';
import type { ContentBlock, ParsedSession, ParsedMessage, ParsedToolCall } from './claude-code.js';
import { codexInvocationMode } from '../util/invocation-mode.js';

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

// --- Parse Codex JSONL content into ParsedSession ---

export function parseCodexSessionMessages(
  jsonlContent: string,
  sessionId: string,
  filePath?: string,
): ParsedSession {
  const messages: ParsedMessage[] = [];
  const toolCalls: ParsedToolCall[] = [];
  let firstUserMessage: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let userMessageCount = 0;
  let cwd: string | null = null;
  let originator: string | undefined;
  // Latest context-window occupancy from token_count telemetry (in file order).
  // Numerator is last_token_usage.input_tokens, which is cache-inclusive.
  let contextUsedTokens: number | undefined;
  let contextWindowReported: number | undefined;

  const lines: CodexLine[] = [];
  for (const raw of jsonlContent.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as CodexLine);
    } catch {
      continue;
    }
  }

  // Extract session metadata
  for (const line of lines) {
    if (line.type === 'session_meta' && line.payload) {
      cwd = (line.payload.cwd as string) ?? null;
      startedAt = line.payload.timestamp ?? line.timestamp ?? null;
      originator = line.payload.originator;
      break;
    }
  }

  // Process response_item lines as messages
  for (const line of lines) {
    const timestamp = line.timestamp ?? null;
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
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

    if (line.type !== 'response_item' || !line.payload) continue;

    const role = line.payload.role;
    const contentBlocks = line.payload.content;
    const toolName = line.payload.name;
    const toolInput = parseToolInput(line.payload);

    // Tool call response_item (no role, has name + input)
    if (toolName && !role) {
      const blocks: ContentBlock[] = [{
        type: 'tool_use',
        name: toolName,
        input: toolInput,
      }];

      toolCalls.push({
        session_id: sessionId,
        tool_name: toolName,
        category: categorizeCodexToolName(toolName),
        tool_use_id: null,
        input_json: toolInput != null ? JSON.stringify(toolInput) : null,
        subagent_session_id: null,
        message_ordinal: messages.length,
      });

      const contentJson = JSON.stringify(blocks);
      messages.push({
        session_id: sessionId,
        ordinal: messages.length,
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
      if (firstUserMessage === null) {
        const text = blocks.find(b => b.type === 'text')?.text?.trim();
        if (text) {
          firstUserMessage = text.replace(/\s+/g, ' ').slice(0, 200) || null;
        }
      }
    }

    messages.push({
      session_id: sessionId,
      ordinal: messages.length,
      role,
      content: contentJson,
      timestamp,
      has_thinking: 0,
      has_tool_use: 0,
      content_length: contentJson.length,
    });
  }

  const project = cwd ? path.basename(cwd) : (filePath ? projectFromCodexPath(filePath) : null);

  return {
    messages,
    toolCalls,
    metadata: {
      session_id: sessionId,
      project,
      agent: 'codex',
      first_message: firstUserMessage,
      started_at: startedAt,
      ended_at: endedAt,
      message_count: messages.length,
      user_message_count: userMessageCount,
      parent_session_id: null,
      relationship_type: null,
      mode: codexInvocationMode(originator),
      context_used_tokens: contextUsedTokens,
      context_window_reported: contextWindowReported,
    },
  };
}

function projectFromCodexPath(_filePath: string): string | null {
  return null;
}
