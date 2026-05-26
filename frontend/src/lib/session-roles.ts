import type { ContentBlock, Message } from './api/client';

/** Who a transcript turn is attributed to in the viewer. */
export type MessageAuthor = 'you' | 'assistant' | 'tool';

/**
 * Classify a transcript message by displayed author.
 *
 * Claude Code stores `tool_result` blocks under the `user` role, so a user
 * turn that is *only* tool_result blocks is the environment talking back to
 * the model ("Tool"), not the human ("You"). Any text from the user — even
 * alongside a tool_result — counts as genuine human input.
 */
export function classifyMessageAuthor(message: Pick<Message, 'role' | 'content'>): MessageAuthor {
  if (message.role !== 'user') return 'assistant';
  try {
    const blocks = JSON.parse(message.content) as ContentBlock[];
    if (Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => block?.type === 'tool_result')) {
      return 'tool';
    }
  } catch {
    // Non-JSON content is plain human text.
  }
  return 'you';
}
