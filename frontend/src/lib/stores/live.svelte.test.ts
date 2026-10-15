import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, type LiveItem, type LiveSession } from '../api/client';

const fetchLiveSession = vi.fn();
const fetchLiveTurns = vi.fn();
const fetchLiveItems = vi.fn();
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchLiveSession: (...args: unknown[]) => fetchLiveSession(...args),
  fetchLiveTurns: (...args: unknown[]) => fetchLiveTurns(...args),
  fetchLiveItems: (...args: unknown[]) => fetchLiveItems(...args),
}));

let store: typeof import('./live.svelte');
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  fetchLiveSession.mockReset().mockImplementation(async (id: string) => ({ id, live_status: 'live' }) as LiveSession);
  fetchLiveTurns.mockReset().mockResolvedValue({ data: [] });
  fetchLiveItems.mockReset().mockResolvedValue({ data: [{ id: 1 } as LiveItem], total: 1 });
  store = await import('./live.svelte');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('following one session in Monitor', () => {
  it('loads the followed session', async () => {
    await store.followLiveSession('s1');
    expect(store.getSelectedLiveSessionId()).toBe('s1');
    expect(store.getSelectedLiveSession()?.id).toBe('s1');
    expect(store.getLiveItems().map(item => item.id)).toEqual([1]);
    expect(store.getLiveSessionMissing()).toBe(false);
  });

  it('marks a session with no live record as missing, but not one that failed to load', async () => {
    fetchLiveSession.mockRejectedValueOnce(new ApiError('fetchLiveSession failed (404): ', 404));
    await store.followLiveSession('gone');
    expect(store.getLiveSessionMissing()).toBe(true);

    fetchLiveSession.mockRejectedValueOnce(new ApiError('fetchLiveSession failed (500): ', 500));
    await store.followLiveSession('flaky');
    expect(store.getLiveSessionMissing()).toBe(false);

    fetchLiveSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await store.followLiveSession('offline');
    expect(store.getLiveSessionMissing()).toBe(false);
  });

  it('a record that fails to load for another reason reads as failed, until a retry loads it', async () => {
    fetchLiveSession.mockRejectedValueOnce(new ApiError('fetchLiveSession failed (500): ', 500));
    await store.followLiveSession('flaky');
    expect(store.getLiveSessionLoadFailed()).toBe(true);
    expect(store.getLiveSessionMissing()).toBe(false);

    await store.followLiveSession('flaky');
    expect(store.getLiveSessionLoadFailed()).toBe(false);
    expect(store.getSelectedLiveSession()?.id).toBe('flaky');
  });

  it("a failed record recovers when the session's next update loads it", async () => {
    fetchLiveSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await store.followLiveSession('s1');
    expect(store.getLiveSessionLoadFailed()).toBe(true);

    store.handleLiveEvent({ type: 'session_presence', payload: { session_id: 's1' } });
    await vi.runAllTimersAsync();
    expect(store.getLiveSessionLoadFailed()).toBe(false);
  });

  it('a later session that loads clears the missing mark', async () => {
    fetchLiveSession.mockRejectedValueOnce(new ApiError('fetchLiveSession failed (404): ', 404));
    await store.followLiveSession('gone');
    await store.followLiveSession('s1');
    expect(store.getLiveSessionMissing()).toBe(false);
  });

  it('a session whose live record appears after the click stops reading as missing', async () => {
    // A new session's card can come from its first hook event before the live
    // projection has written the session.
    fetchLiveSession.mockRejectedValueOnce(new ApiError('fetchLiveSession failed (404): ', 404));
    await store.followLiveSession('new');
    expect(store.getLiveSessionMissing()).toBe(true);

    store.handleLiveEvent({ type: 'session_presence', payload: { session_id: 'new' } });
    await vi.runAllTimersAsync();

    expect(store.getLiveSessionMissing()).toBe(false);
    expect(store.getSelectedLiveSession()?.id).toBe('new');
  });

  it('activity in other sessions never moves or refreshes the followed one', async () => {
    await store.followLiveSession('s1');
    fetchLiveSession.mockClear();
    fetchLiveItems.mockClear();

    for (const type of ['session_presence', 'turn_update', 'item_delta']) {
      store.handleLiveEvent({ type, payload: { session_id: 'other' } });
    }
    await vi.runAllTimersAsync();

    expect(store.getSelectedLiveSessionId()).toBe('s1');
    expect(fetchLiveSession).not.toHaveBeenCalled();
    expect(fetchLiveItems).not.toHaveBeenCalled();
  });

  it('new items in the followed session are appended and its status refreshed', async () => {
    await store.followLiveSession('s1');
    fetchLiveSession.mockClear();
    fetchLiveItems.mockClear().mockResolvedValue({ data: [{ id: 2 } as LiveItem], total: 2 });

    store.handleLiveEvent({ type: 'item_delta', payload: { session_id: 's1' } });
    await vi.runAllTimersAsync();

    expect(fetchLiveSession).toHaveBeenCalledWith('s1');
    expect(store.getLiveItems().map(item => item.id)).toEqual([1, 2]);
  });

  it('opens at the newest items and loads earlier ones on request', async () => {
    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }) as LiveItem);
    fetchLiveItems.mockReset()
      .mockResolvedValueOnce({ data: page(201, 300), total: 300, before_cursor: '201' })
      .mockResolvedValueOnce({ data: page(101, 200), total: 300, before_cursor: '101' })
      .mockResolvedValueOnce({ data: page(1, 100), total: 300 });

    await store.followLiveSession('s1');
    expect(fetchLiveItems).toHaveBeenLastCalledWith('s1', expect.objectContaining({ tail: true }));
    expect(store.getLiveItems().map(item => item.id).slice(0, 2)).toEqual([201, 202]);
    expect(store.getSelectedLiveItemId()).toBe(300);
    expect(store.getLiveItemsHasEarlier()).toBe(true);

    await store.loadEarlierLiveItems();
    expect(fetchLiveItems).toHaveBeenLastCalledWith('s1', expect.objectContaining({ before: '201' }));
    await store.loadEarlierLiveItems();
    expect(fetchLiveItems).toHaveBeenLastCalledWith('s1', expect.objectContaining({ before: '101' }));
    expect(store.getLiveItems().map(item => item.id)).toEqual(page(1, 300).map(item => item.id));
    expect(store.getLiveItemsHasEarlier()).toBe(false);
    // Loading earlier items keeps the selection.
    expect(store.getSelectedLiveItemId()).toBe(300);
  });

  it('new items are read after the newest one held, however many pages arrived', async () => {
    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }) as LiveItem);
    fetchLiveItems.mockReset().mockResolvedValueOnce({ data: page(201, 250), total: 250, before_cursor: '201' });
    await store.followLiveSession('s1');

    // 150 new items: a full page with a cursor, then the rest.
    fetchLiveItems
      .mockResolvedValueOnce({ data: page(251, 350), total: 400, cursor: '350' })
      .mockResolvedValueOnce({ data: page(351, 400), total: 400 });
    store.handleLiveEvent({ type: 'item_delta', payload: { session_id: 's1' } });
    await vi.runAllTimersAsync();

    expect(fetchLiveItems.mock.calls.slice(1).map(call => (call[1] as { cursor?: string }).cursor)).toEqual(['250', '350']);
    expect(store.getLiveItems().at(-1)?.id).toBe(400);
    expect(store.getLiveItems()).toHaveLength(200);
  });

  it('a burst larger than one catch-up keeps reading until it is caught up', async () => {
    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }) as LiveItem);
    fetchLiveItems.mockReset().mockResolvedValueOnce({ data: page(1, 100), total: 100 });
    await store.followLiveSession('s1');

    // 2,550 new items: 25 full pages, then a short one.
    let next = 101;
    fetchLiveItems.mockImplementation(async () => {
      const from = next;
      const to = Math.min(from + 99, 2650);
      next = to + 1;
      return { data: page(from, to), total: 2650, cursor: to - from + 1 === 100 ? String(to) : undefined };
    });
    store.handleLiveEvent({ type: 'item_delta', payload: { session_id: 's1' } });
    await vi.runAllTimersAsync();

    expect(store.getLiveItems().at(-1)?.id).toBe(2650);
  });

  it('stopping drops the stream and cancels a pending refresh', async () => {
    await store.followLiveSession('s1');
    store.handleLiveEvent({ type: 'item_delta', payload: { session_id: 's1' } });
    store.stopFollowingLiveSession();
    fetchLiveItems.mockClear();
    await vi.runAllTimersAsync();

    expect(store.getSelectedLiveSessionId()).toBeNull();
    expect(store.getLiveItems()).toEqual([]);
    expect(fetchLiveItems).not.toHaveBeenCalled();
  });
});
