import { describe, it, expect, beforeEach, vi } from 'vitest';

// The router reads the hash once at import and then listens for hashchange, so
// each case sets the starting URL and imports a fresh module.
let router: typeof import('./router.svelte');
async function loadAt(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  vi.resetModules();
  router = await import('./router.svelte');
}

function currentHash(): string {
  return window.location.hash.replace(/^#/, '');
}

describe('Monitor drill-in routing', () => {
  beforeEach(async () => {
    await loadAt('');
  });

  it('rewrites an old #live link to Monitor without leaving it in history', async () => {
    await loadAt('#live');
    expect(router.getTab()).toBe('monitor');
    expect(currentHash()).toBe('');
    expect(router.getMonitorSessionId()).toBeNull();
  });

  it('opens Monitor on the followed session from a deep link', async () => {
    await loadAt('#monitor?session=abc-123');
    expect(router.getTab()).toBe('monitor');
    expect(router.getMonitorSessionId()).toBe('abc-123');
  });

  it('opening a session puts it in the hash, and the Monitor tab returns to the cards', () => {
    router.setTab('sessions');
    router.openMonitorSession('abc-123');
    expect(router.getTab()).toBe('monitor');
    expect(router.getMonitorSessionId()).toBe('abc-123');
    expect(currentHash()).toBe('monitor?session=abc-123');

    router.setTab('monitor');
    expect(router.getMonitorSessionId()).toBeNull();
    expect(currentHash()).toBe('');
  });

  it('leaving Monitor by hash drops the followed session', async () => {
    router.openMonitorSession('abc-123');
    window.location.hash = 'sessions';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(router.getTab()).toBe('sessions');
    expect(router.getMonitorSessionId()).toBeNull();
  });
});
