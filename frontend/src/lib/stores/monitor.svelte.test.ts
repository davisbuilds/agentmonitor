import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentEvent, Session } from '../api/client';

// The store is a module singleton built on `$state`. Reset the module registry
// before each test so every case starts from fresh state rather than inheriting
// the previous test's events/sessions/signals.
let store: typeof import('./monitor.svelte');
beforeEach(async () => {
  vi.resetModules();
  store = await import('./monitor.svelte');
});

function ev(id: number, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id, ...extra } as AgentEvent;
}

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: 'claude_code',
    agent_type: 'claude_code',
    project: 'p',
    branch: 'main',
    status: 'active',
    started_at: '2026-09-11T00:00:00Z',
    last_event_at: '2026-09-11T00:00:00Z',
    event_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    total_cost_usd: 0,
    files_edited: 0,
    lines_added: 0,
    lines_removed: 0,
    ...extra,
  } as Session;
}

describe('setEvents — authoritative snapshot vs. in-flight live prepend', () => {
  it('replaces the feed when nothing newer is live', () => {
    store.setEvents([ev(5), ev(4), ev(3)]);
    expect(store.getEvents().map((e) => e.id)).toEqual([5, 4, 3]);
  });

  it('preserves a live event newer than the snapshot high-water mark', () => {
    // A live event (id 10) arrives via SSE while the REST reload is in flight.
    store.addEvent(ev(10));
    // The reload returns an older snapshot that predates the live event.
    store.setEvents([ev(8), ev(7), ev(6)]);
    // The naive `slice(200)` replace would drop id 10; the merge must keep it.
    expect(store.getEvents().map((e) => e.id)).toEqual([10, 8, 7, 6]);
  });

  it('dedups an id present in both the snapshot and the live prepend', () => {
    store.addEvent(ev(9));
    // id 9 appears in the snapshot too (the importer persisted the live event).
    store.setEvents([ev(9), ev(8)]);
    expect(store.getEvents().map((e) => e.id)).toEqual([9, 8]);
  });

  it('sorts merged events by id descending', () => {
    store.addEvent(ev(12));
    store.setEvents([ev(5), ev(11), ev(3)]);
    expect(store.getEvents().map((e) => e.id)).toEqual([12, 11, 5, 3]);
  });

  it('caps the merged feed at 200', () => {
    store.addEvent(ev(10_000));
    store.setEvents(Array.from({ length: 250 }, (_, i) => ev(250 - i)));
    const ids = store.getEvents().map((e) => e.id);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe(10_000);
  });
});

describe('reconnect signal', () => {
  it('starts at 0 and increments on each signal', () => {
    expect(store.getReconnectSignal()).toBe(0);
    store.signalReconnect();
    expect(store.getReconnectSignal()).toBe(1);
    store.signalReconnect();
    expect(store.getReconnectSignal()).toBe(2);
  });
});

describe('incrementEvent — optimistic stats totals', () => {
  it('adds the event token and cost deltas to running totals', () => {
    store.setStats({ ...store.getStats(), total_events: 2, total_tokens_in: 100, total_cost_usd: 1 });
    store.incrementEvent(ev(1, { tokens_in: 50, tokens_out: 20, cost_usd: 0.25 }));
    const s = store.getStats();
    expect(s.total_events).toBe(3);
    expect(s.total_tokens_in).toBe(150);
    expect(s.total_tokens_out).toBe(20);
    expect(s.total_cost_usd).toBe(1.25);
  });

  it('treats missing token/cost fields as zero', () => {
    store.incrementEvent(ev(1));
    const s = store.getStats();
    expect(s.total_events).toBe(1);
    expect(s.total_tokens_in).toBe(0);
    expect(s.total_cost_usd).toBe(0);
  });
});

describe('handleSessionUpdate — idle_check', () => {
  it('flips active sessions past the 5-minute threshold to idle and leaves fresh ones active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T01:00:00Z'));
    store.setSessions([
      session('stale', { last_event_at: '2026-09-11T00:50:00Z' }), // 10m ago → idle
      session('fresh', { last_event_at: '2026-09-11T00:58:00Z' }), // 2m ago → active
      session('ended', { status: 'ended', last_event_at: '2026-09-11T00:00:00Z' }),
    ]);
    store.handleSessionUpdate({ type: 'idle_check' });
    const byId = Object.fromEntries(store.getSessions().map((s) => [s.id, s.status]));
    expect(byId).toEqual({ stale: 'idle', fresh: 'active', ended: 'ended' });
    vi.useRealTimers();
  });

  it('bumps the auto-import signal on auto_import and resync', () => {
    expect(store.getAutoImportSignal()).toBe(0);
    store.handleSessionUpdate({ type: 'auto_import' });
    store.handleSessionUpdate({ type: 'resync' });
    expect(store.getAutoImportSignal()).toBe(2);
  });
});
