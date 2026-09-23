import { describe, it, expect } from 'vitest';
import type { BrowsingSession } from '../api/client';
import { SessionList } from './session-list.svelte';

type Page = { data: BrowsingSession[]; total: number; cursor?: string };

/** A fetch whose responses the test releases in any order. */
function controlledFetch() {
  const pending: Array<{ params: Record<string, string | number | undefined>; resolve: (page: Page) => void; reject: (err: Error) => void }> = [];
  const fetchPage = (params: Record<string, string | number | undefined> = {}) =>
    new Promise<Page>((resolve, reject) => pending.push({ params, resolve, reject }));
  return { fetchPage, pending };
}

const page = (ids: string[], cursor?: string): Page => ({
  data: ids.map(id => ({ id }) as BrowsingSession),
  total: ids.length,
  cursor,
});

describe('SessionList ignores responses to superseded requests', () => {
  it('keeps the newer filter when the older response lands last', async () => {
    const { fetchPage, pending } = controlledFetch();
    const list = new SessionList(fetchPage, 2);

    const first = list.load({ project: 'alpha', agent: '' });
    const second = list.load({ project: 'alpha', agent: 'codex' });
    pending[1].resolve(page(['codex-1']));
    await second;
    pending[0].resolve(page(['any-1', 'any-2'], 'c-old'));
    await first;

    expect(list.sessions.map(s => s.id)).toEqual(['codex-1']);
    expect(list.total).toBe(1);
    expect(list.hasMore).toBe(false);
    expect(list.loading).toBe(false);
  });

  it('pages from the newer result, not a stale cursor', async () => {
    const { fetchPage, pending } = controlledFetch();
    const list = new SessionList(fetchPage, 1);

    const first = list.load({ project: 'alpha', agent: '' });
    const second = list.load({ project: 'beta', agent: '' });
    pending[1].resolve(page(['beta-1'], 'c-beta'));
    await second;
    pending[0].resolve(page(['alpha-1'], 'c-alpha'));
    await first;

    void list.load({ project: 'beta', agent: '', append: true });
    expect(pending[2].params.cursor).toBe('c-beta');
  });

  it('stays loading until the newest request settles', async () => {
    const { fetchPage, pending } = controlledFetch();
    const list = new SessionList(fetchPage, 2);

    const first = list.load({ project: 'alpha', agent: '' });
    void list.load({ project: 'beta', agent: '' });
    pending[0].resolve(page(['alpha-1']));
    await first;

    expect(list.loading).toBe(true);
    expect(list.sessions).toEqual([]);
  });

  it('does not report a superseded request\'s failure', async () => {
    const { fetchPage, pending } = controlledFetch();
    const list = new SessionList(fetchPage, 2);
    const originalError = console.error;
    console.error = () => {};
    try {
      const first = list.load({ project: 'alpha', agent: '' });
      const second = list.load({ project: 'beta', agent: '' });
      pending[1].resolve(page(['beta-1']));
      await second;
      pending[0].reject(new Error('network'));
      await first;
      expect(list.error).toBeNull();
      expect(list.sessions.map(s => s.id)).toEqual(['beta-1']);
    } finally {
      console.error = originalError;
    }
  });
});
