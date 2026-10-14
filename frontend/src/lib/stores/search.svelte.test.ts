import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SearchResult } from '../api/client';

type Page = { data: SearchResult[]; total: number; cursor?: string };

const pending: Array<{ params: Record<string, unknown>; resolve: (page: Page) => void }> = [];
const searchMessages = vi.fn((params: Record<string, unknown>) =>
  new Promise<Page>((resolve) => pending.push({ params, resolve })));
const fetchBrowsingSessions = vi.fn(async () => ({ data: [], total: 0 }));

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  searchMessages: (params: Record<string, unknown>) => searchMessages(params),
  fetchBrowsingSessions: () => fetchBrowsingSessions(),
}));

let createSearchStore: typeof import('./search.svelte').createSearchStore;
beforeEach(async () => {
  vi.resetModules();
  pending.length = 0;
  searchMessages.mockClear();
  fetchBrowsingSessions.mockClear();
  ({ createSearchStore } = await import('./search.svelte'));
});
afterEach(() => {
  vi.useRealTimers();
});

const result = (messageId: number): SearchResult => ({ message_id: messageId } as SearchResult);

describe('SearchStore.update', () => {
  it('searches right away when asked, with the query, filters and sort it was given', () => {
    const store = createSearchStore({ recentLimit: 0 });
    store.update({ query: ' quota ', project: 'am', agent: 'codex', sort: 'relevance' }, { immediate: true });
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(pending[0].params).toMatchObject({ q: 'quota', project: 'am', agent: 'codex', sort: 'relevance' });
  });

  it('waits for a pause in typing before searching', () => {
    vi.useFakeTimers();
    const store = createSearchStore({ recentLimit: 0 });
    store.update({ query: 'q' });
    store.update({ query: 'qu' });
    expect(searchMessages).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(pending[0].params).toMatchObject({ q: 'qu' });
  });

  it('drops a search still in flight when the query is cleared', async () => {
    const store = createSearchStore({ recentLimit: 0 });
    store.update({ query: 'quota' }, { immediate: true });
    store.update({ query: '' });
    pending[0].resolve({ data: [result(1)], total: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.results).toEqual([]);
    expect(store.total).toBe(0);
    expect(store.loading).toBe(false);
  });

  it('never loads recent sessions when recentLimit is 0', () => {
    const store = createSearchStore({ recentLimit: 0 });
    store.update({ query: '' });
    expect(fetchBrowsingSessions).not.toHaveBeenCalled();

    const palette = createSearchStore({ recentLimit: 10 });
    palette.update({ query: '' });
    expect(fetchBrowsingSessions).toHaveBeenCalledTimes(1);
  });
});
