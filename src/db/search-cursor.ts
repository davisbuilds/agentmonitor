type SearchSort = 'recent' | 'relevance';

export class InvalidSearchCursorError extends Error {
  constructor(sort: SearchSort) {
    super(`Invalid cursor for ${sort} search. Use the cursor returned by the previous page with the same sort.`);
  }
}

export function decodeSearchCursor(cursor: unknown, sort: SearchSort): { message_id: number; rank?: number } | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string') throw new InvalidSearchCursorError(sort);

  if (sort === 'recent') {
    const id = Number(cursor);
    if (/^\d+$/.test(cursor) && Number.isSafeInteger(id) && id > 0) return { message_id: id };
  } else {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') === cursor) {
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new InvalidSearchCursorError(sort);
      }
      if (Number.isFinite(value?.rank) && Number.isSafeInteger(value?.message_id) && value.message_id > 0) {
        return { rank: value.rank, message_id: value.message_id };
      }
    }
  }
  throw new InvalidSearchCursorError(sort);
}
