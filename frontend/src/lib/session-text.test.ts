import { describe, it, expect } from 'vitest';
import { getMessagePreviewText, getSessionPreviewText, parseSessionText } from './session-text';

const ESC = '\u001b';

describe('parseSessionText — Claude Code local-command wrappers', () => {
  it('returns null for empty input', () => {
    expect(parseSessionText(null)).toBeNull();
    expect(parseSessionText(undefined)).toBeNull();
    expect(parseSessionText('')).toBeNull();
  });

  it('extracts a caveat, stripping ANSI colour codes and surrounding whitespace', () => {
    expect(
      parseSessionText(`<local-command-caveat>\n  ${ESC}[1mCaveat:${ESC}[0m do not respond  \n</local-command-caveat>`),
    ).toEqual({ kind: 'caveat', text: 'Caveat: do not respond' });
  });

  it('splits a slash command into name, message, and args (whitespace between tags allowed)', () => {
    expect(
      parseSessionText(
        '<command-name>/model</command-name>\n  <command-message>model</command-message>\n<command-args> opus </command-args>',
      ),
    ).toEqual({ kind: 'command', name: '/model', message: 'model', args: 'opus' });
  });

  it('keeps empty command args as an empty string', () => {
    expect(
      parseSessionText('<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>'),
    ).toEqual({ kind: 'command', name: '/clear', message: 'clear', args: '' });
  });

  it('does not treat an incomplete command wrapper as a command', () => {
    const text = '<command-name>/clear</command-name><command-message>clear</command-message>';
    expect(parseSessionText(text)).toEqual({ kind: 'plain', text });
  });

  it('tags stdout and stderr output with their stream', () => {
    expect(parseSessionText(`<local-command-stdout>${ESC}[32mSet model to opus${ESC}[39m</local-command-stdout>`)).toEqual({
      kind: 'output',
      stream: 'stdout',
      text: 'Set model to opus',
    });
    expect(parseSessionText('<local-command-stderr> boom </local-command-stderr>')).toEqual({
      kind: 'output',
      stream: 'stderr',
      text: 'boom',
    });
  });

  it('rejects output whose opening and closing streams disagree', () => {
    const text = '<local-command-stdout>mixed</local-command-stderr>';
    expect(parseSessionText(text)).toEqual({ kind: 'plain', text });
  });

  it('prefers the caveat when a message carries both a caveat and a command', () => {
    const text =
      '<local-command-caveat>note</local-command-caveat><command-name>/x</command-name><command-message>x</command-message><command-args></command-args>';
    expect(parseSessionText(text)?.kind).toBe('caveat');
  });

  it('returns other text as plain, ANSI-stripped and trimmed', () => {
    expect(parseSessionText(`  ${ESC}[31mhello${ESC}[0m world \n`)).toEqual({ kind: 'plain', text: 'hello world' });
  });
});

describe('getSessionPreviewText — list/preview snippets', () => {
  it('collapses internal whitespace in plain text to single spaces', () => {
    expect(getSessionPreviewText('fix the\n\n  flaky\ttest')).toBe('fix the flaky test');
  });

  it('hides command plumbing from previews', () => {
    expect(getSessionPreviewText('<local-command-caveat>c</local-command-caveat>')).toBeNull();
    expect(
      getSessionPreviewText('<command-name>/model</command-name><command-message>m</command-message><command-args>a</command-args>'),
    ).toBeNull();
    expect(getSessionPreviewText('<local-command-stdout>ok</local-command-stdout>')).toBeNull();
  });

  it('returns null for empty or whitespace-only text', () => {
    expect(getSessionPreviewText(null)).toBeNull();
    expect(getSessionPreviewText('   \n\t ')).toBeNull();
    expect(getSessionPreviewText(`${ESC}[0m`)).toBeNull();
  });
});

describe('getMessagePreviewText — stored message content', () => {
  it('previews the first text block of a block array, skipping non-text blocks', () => {
    const content = JSON.stringify([
      { type: 'tool_use', name: 'Read' },
      // A non-text block that happens to carry a `text` field is still not the answer.
      { type: 'tool_result', text: 'file contents' },
      { type: 'text', text: 'first  answer' },
      { type: 'text', text: 'second' },
    ]);
    expect(getMessagePreviewText({ content })).toBe('first answer');
  });

  it('skips a text block whose text is not a string', () => {
    const content = JSON.stringify([{ type: 'text', text: 42 }, { type: 'text', text: 'real' }]);
    expect(getMessagePreviewText({ content })).toBe('real');
  });

  it('returns null when the block array has no text block', () => {
    expect(getMessagePreviewText({ content: JSON.stringify([{ type: 'tool_result', content: 'x' }]) })).toBeNull();
    expect(getMessagePreviewText({ content: '[]' })).toBeNull();
  });

  it('treats non-JSON content as the text itself', () => {
    expect(getMessagePreviewText({ content: 'plain   human text' })).toBe('plain human text');
  });

  it('applies the command filter to the extracted text block', () => {
    const content = JSON.stringify([{ type: 'text', text: '<local-command-stdout>ok</local-command-stdout>' }]);
    expect(getMessagePreviewText({ content })).toBeNull();
  });
});
