import { describe, it, expect } from 'vitest';
import { setEvents, getEvents } from './monitor.svelte';
import type { AgentEvent } from '../api/client';

// Canary: proves the Vitest harness compiles rune-bearing `.svelte.ts` modules
// (module-level `$state` in monitor.svelte.ts) so the runner is confirmed to
// exercise runes, not just plain TS. Real store tests live alongside; this stays
// as a minimal smoke check that the compile path is wired.
function ev(id: number): AgentEvent {
  return { id } as AgentEvent;
}

describe('vitest harness canary', () => {
  it('compiles a $state module and reads it back', () => {
    setEvents([ev(2), ev(1)]);
    expect(getEvents().map((e) => e.id)).toEqual([2, 1]);
  });
});
