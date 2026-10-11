import type { ContentBlock, Message } from './api/client';

/** A stored message's content blocks; content that is not a block array reads as one text block. */
export function parseMessageBlocks(content: string): ContentBlock[] {
  try {
    const blocks = JSON.parse(content) as unknown;
    if (Array.isArray(blocks)) return blocks as ContentBlock[];
  } catch {
    // Plain text content.
  }
  return [{ type: 'text', text: content }];
}

/**
 * A thinking block's text. The parsers store it under `text`; `thinking` is the
 * raw transcript field. Claude Code often records the block with its text left
 * out, which reads as an empty string here.
 */
export function thinkingText(block: ContentBlock): string {
  const text = block.text ?? block.thinking ?? '';
  return text.trim() ? text : '';
}

/** Whether the viewer has anything to render for this block. */
export function isVisibleBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' && block.text.trim() !== '';
    case 'thinking':
      return thinkingText(block) !== '';
    case 'tool_use':
      return Boolean(block.name);
    case 'tool_result':
      return true;
    default:
      return false;
  }
}

/** Whether a message shows anything beyond its header. */
export function hasVisibleContent(message: Pick<Message, 'content'>): boolean {
  return parseMessageBlocks(message.content).some(isVisibleBlock);
}

/** Whether any of the message's thinking blocks recorded text. */
export function hasThinkingText(message: Pick<Message, 'content'>): boolean {
  return parseMessageBlocks(message.content).some(block => block.type === 'thinking' && thinkingText(block) !== '');
}
