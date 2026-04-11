import path from 'path';
import type { ContentBlock, ParsedSession, ParsedMessage, ParsedToolCall, ParsedSessionMetadata } from './claude-code.js';

// --- Codex JSONL line types ---

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
    [key: string]: unknown;
  };
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

    if (line.type !== 'response_item' || !line.payload) continue;

    const role = line.payload.role;
    const contentBlocks = line.payload.content;
    const toolName = line.payload.name;
    const toolInput = line.payload.input;

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
        category: toolName === 'apply_patch' ? 'Edit' : 'Other',
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
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
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
    },
  };
}

function projectFromCodexPath(filePath: string): string | null {
  // Codex session files don't encode project in path.
  // Project comes from cwd in session_meta.
  return null;
}
