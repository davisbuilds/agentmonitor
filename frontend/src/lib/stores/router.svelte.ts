export type Tab = 'monitor' | 'sessions' | 'analytics' | 'search';

let currentTab = $state<Tab>('monitor');
let pendingSessionId = $state<string | null>(null);

export function getTab(): Tab {
  return currentTab;
}

export function setTab(tab: Tab): void {
  currentTab = tab;
  window.location.hash = tab === 'monitor' ? '' : tab;
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
  const hash = window.location.hash.slice(1);
  if (hash === 'sessions' || hash === 'analytics' || hash === 'search') {
    currentTab = hash;
  }
}

initFromHash();
window.addEventListener('hashchange', initFromHash);
