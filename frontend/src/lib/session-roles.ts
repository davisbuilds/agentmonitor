import type { ContentBlock, Message } from './api/client';

/** Who a transcript turn is attributed to in the viewer. */
export type MessageAuthor = 'you' | 'assistant' | 'tool' | 'instructions';

/**
 * Classify a transcript message by displayed author.
 *
 * Claude Code stores `tool_result` blocks under the `user` role, so a user
 * turn that is *only* tool_result blocks is the environment talking back to
 * the model ("Tool"), not the human ("You"). Any text from the user — even
 * alongside a tool_result — counts as genuine human input.
 */
export function classifyMessageAuthor(message: Pick<Message, 'role' | 'content'>): MessageAuthor {
  // WHY: Separate harness instructions from user input and assistant output because Codex records them
  // as system or developer messages.
  if (message.role === 'developer' || message.role === 'system') return 'instructions';
  if (message.role !== 'user') return 'assistant';
  try {
    const blocks = JSON.parse(message.content) as ContentBlock[];
    if (Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => block?.type === 'tool_result')) {
      return 'tool';
    }
  } catch {
    // WHY: Treat content that was never encoded as JSON as human text.
  }
  return 'you';
}
