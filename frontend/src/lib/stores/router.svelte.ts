export type Tab = 'monitor' | 'live' | 'sessions' | 'pinned' | 'analytics' | 'usage' | 'search';

let currentTab = $state<Tab>('monitor');
let pendingSessionId = $state<string | null>(null);
let pendingMessageOrdinal = $state<number | null>(null);

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
  pendingMessageOrdinal = null;
  setTab('sessions');
}

export function navigateToSessionMessage(sessionId: string, messageOrdinal: number): void {
  pendingSessionId = sessionId;
  pendingMessageOrdinal = messageOrdinal;
  setTab('sessions');
}

export function consumePendingSessionNavigation(): { sessionId: string | null; messageOrdinal: number | null } {
  const sessionId = pendingSessionId;
  const messageOrdinal = pendingMessageOrdinal;
  pendingSessionId = null;
  pendingMessageOrdinal = null;
  return { sessionId, messageOrdinal };
}

// Initialize from URL hash
function initFromHash(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash.slice(1).split('?')[0];
  if (hash === 'live' || hash === 'sessions' || hash === 'pinned' || hash === 'analytics' || hash === 'usage' || hash === 'search') {
    currentTab = hash;
  }
}

if (typeof window !== 'undefined') {
  initFromHash();
  window.addEventListener('hashchange', initFromHash);
}
