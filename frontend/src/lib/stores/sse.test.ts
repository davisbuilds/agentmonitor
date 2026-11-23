// @vitest-environment node
// WHY: Drive EventSource synchronously under Node because happy-dom tears down an unrelated pending
// task with AbortError.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  // WHY: Import the listener and store after the same module reset so they share one signal instance.
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
    FakeEventSource.latest.onopen?.();
    expect(monitor.getReconnectSignal()).toBe(0);

    FakeEventSource.latest.onerror?.();
    expect(monitor.getConnectionStatus()).toBe('disconnected');

    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.latest.onopen?.();
    expect(monitor.getConnectionStatus()).toBe('connected');
    expect(monitor.getReconnectSignal()).toBe(1);
  });

  it('does not re-signal on a subsequent clean open with no drop in between', () => {
    sse.connectSSE();
    FakeEventSource.latest.onerror?.();
    vi.advanceTimersByTime(1000);
    FakeEventSource.latest.onopen?.();
    expect(monitor.getReconnectSignal()).toBe(1);

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
