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

  it('a later session that loads clears the missing mark', async () => {
    fetchLiveSession.mockRejectedValueOnce(new ApiError('fetchLiveSession failed (404): ', 404));
    await store.followLiveSession('gone');
    await store.followLiveSession('s1');
    expect(store.getLiveSessionMissing()).toBe(false);
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
