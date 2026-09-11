// @vitest-environment node
// This suite injects its own EventSource stand-in and drives it synchronously,
// so it needs no DOM. Running it under happy-dom left a pending async task that
// surfaced as an AbortError during window teardown; the node env avoids that.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A controllable EventSource stand-in: connectSSE() constructs one per connect,
// and the test drives its onopen/onerror to simulate the stream lifecycle
// without any real network.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  static get latest(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

let sse: typeof import('./sse');
let monitor: typeof import('./monitor.svelte');
const realEventSource = globalThis.EventSource;

beforeEach(async () => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  vi.useFakeTimers();
  // Fresh module graph so sse.ts and the monitor store it imports share one
  // instance, and reconnectSignal starts at 0.
  vi.resetModules();
  sse = await import('./sse');
  monitor = await import('./monitor.svelte');
});

afterEach(() => {
  sse.disconnectSSE();
  vi.useRealTimers();
  (globalThis as { EventSource: unknown }).EventSource = realEventSource;
});

describe('SSE reconnect signalling', () => {
  it('does not signal a reconnect on the initial connect', () => {
    sse.connectSSE();
    FakeEventSource.latest.onopen?.();
    expect(monitor.getConnectionStatus()).toBe('connected');
    expect(monitor.getReconnectSignal()).toBe(0);
  });

  it('signals exactly one reconnect on the open that follows a drop', () => {
    sse.connectSSE();
    FakeEventSource.latest.onopen?.(); // initial connect — no signal
    expect(monitor.getReconnectSignal()).toBe(0);

    FakeEventSource.latest.onerror?.(); // stream drops
    expect(monitor.getConnectionStatus()).toBe('disconnected');

    vi.advanceTimersByTime(1000); // backoff fires → reconnect attempt
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.latest.onopen?.(); // reconnect succeeds
    expect(monitor.getConnectionStatus()).toBe('connected');
    expect(monitor.getReconnectSignal()).toBe(1);
  });

  it('does not re-signal on a subsequent clean open with no drop in between', () => {
    sse.connectSSE();
    FakeEventSource.latest.onerror?.();
    vi.advanceTimersByTime(1000);
    FakeEventSource.latest.onopen?.(); // reconnect → signal 1
    expect(monitor.getReconnectSignal()).toBe(1);

    // A spurious duplicate onopen without an intervening drop must not bump again.
    FakeEventSource.latest.onopen?.();
    expect(monitor.getReconnectSignal()).toBe(1);
  });

  it('dispatches an event frame into the store', () => {
    sse.connectSSE();
    FakeEventSource.latest.onopen?.();
    FakeEventSource.latest.onmessage?.({
      data: JSON.stringify({ type: 'event', payload: { id: 42 } }),
    });
    expect(monitor.getEvents().map((e) => e.id)).toContain(42);
  });
});
