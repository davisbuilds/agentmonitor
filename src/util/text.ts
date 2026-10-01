/**
 * Slice to at most `max` UTF-16 units without cutting a surrogate pair in
 * half. A lone high surrogate is stored by SQLite as U+FFFD, so a preview cut
 * through an emoji would end in a replacement character.
 */
export function sliceWithoutSplittingSurrogates(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const cutsPair = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, cutsPair ? max - 1 : max);
}
