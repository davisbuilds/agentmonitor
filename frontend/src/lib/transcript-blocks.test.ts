import { describe, it, expect } from 'vitest';
import { hasThinkingText, hasVisibleContent, isVisibleBlock, parseMessageBlocks, thinkingText } from './transcript-blocks';

const message = (blocks: unknown) => ({ content: JSON.stringify(blocks) });

describe('thinkingText', () => {
  it('reads the stored `text` field, then the raw `thinking` field', () => {
    expect(thinkingText({ type: 'thinking', text: 'stored' })).toBe('stored');
    expect(thinkingText({ type: 'thinking', thinking: 'raw' })).toBe('raw');
    expect(thinkingText({ type: 'thinking', text: 'stored', thinking: 'raw' })).toBe('stored');
  });

  it('reads an empty or whitespace-only thinking block as empty', () => {
    expect(thinkingText({ type: 'thinking', text: '' })).toBe('');
    expect(thinkingText({ type: 'thinking', text: ' \n\t' })).toBe('');
    expect(thinkingText({ type: 'thinking' })).toBe('');
  });
});

describe('isVisibleBlock', () => {
  it('shows text, thinking with text, named tool calls and every tool result', () => {
    expect(isVisibleBlock({ type: 'text', text: 'hi' })).toBe(true);
    expect(isVisibleBlock({ type: 'thinking', text: 'plan' })).toBe(true);
    expect(isVisibleBlock({ type: 'tool_use', name: 'Bash' })).toBe(true);
    expect(isVisibleBlock({ type: 'tool_result', content: '' })).toBe(true);
  });

  it('hides empty text, empty thinking, unnamed calls and unknown blocks', () => {
    expect(isVisibleBlock({ type: 'text', text: '   ' })).toBe(false);
    expect(isVisibleBlock({ type: 'thinking', text: '' })).toBe(false);
    expect(isVisibleBlock({ type: 'tool_use' })).toBe(false);
    expect(isVisibleBlock({ type: 'image' })).toBe(false);
  });
});

describe('hasVisibleContent', () => {
  it('is false for a message holding only an empty thinking block', () => {
    expect(hasVisibleContent(message([{ type: 'thinking', text: '' }]))).toBe(false);
    expect(hasVisibleContent(message([]))).toBe(false);
  });

  it('is true once any block is visible', () => {
    expect(hasVisibleContent(message([{ type: 'thinking', text: '' }, { type: 'text', text: 'Done.' }]))).toBe(true);
    expect(hasVisibleContent(message([{ type: 'thinking', text: 'Considering' }]))).toBe(true);
  });

  it('treats non-JSON content as text', () => {
    expect(hasVisibleContent({ content: 'plain words' })).toBe(true);
    expect(hasVisibleContent({ content: '' })).toBe(false);
  });
});

describe('hasThinkingText', () => {
  it('is true only when a thinking block recorded text', () => {
    expect(hasThinkingText(message([{ type: 'thinking', text: 'why' }]))).toBe(true);
    expect(hasThinkingText(message([{ type: 'thinking', text: '' }, { type: 'text', text: 'why' }]))).toBe(false);
  });
});

describe('parseMessageBlocks', () => {
  it('returns a block array as stored and wraps anything else as one text block', () => {
    expect(parseMessageBlocks('[{"type":"text","text":"a"}]')).toEqual([{ type: 'text', text: 'a' }]);
    expect(parseMessageBlocks('{"type":"text"}')).toEqual([{ type: 'text', text: '{"type":"text"}' }]);
    expect(parseMessageBlocks('not json')).toEqual([{ type: 'text', text: 'not json' }]);
  });
});
