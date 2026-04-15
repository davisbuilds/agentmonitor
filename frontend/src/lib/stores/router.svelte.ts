export type Tab = 'monitor' | 'live' | 'sessions' | 'analytics' | 'search';

let currentTab = $state<Tab>('monitor');
let pendingSessionId = $state<string | null>(null);

export function getTab(): Tab {
  return currentTab;
}

export function setTab(tab: Tab): void {
  currentTab = tab;
  if (typeof window !== 'undefined') {
    window.location.hash = tab === 'monitor' ? '' : tab;
  }
}

export function navigateToSession(sessionId: string): void {
  pendingSessionId = sessionId;
  setTab('sessions');
}

export function consumePendingSession(): string | null {
  const id = pendingSessionId;
  pendingSessionId = null;
  return id;
}

// Initialize from URL hash
function initFromHash(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash.slice(1).split('?')[0];
  if (hash === 'live' || hash === 'sessions' || hash === 'analytics' || hash === 'search') {
    currentTab = hash;
  }
}

if (typeof window !== 'undefined') {
  initFromHash();
  window.addEventListener('hashchange', initFromHash);
}
