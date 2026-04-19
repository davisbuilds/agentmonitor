export type Tab = 'monitor' | 'live' | 'sessions' | 'pinned' | 'analytics' | 'usage' | 'insights' | 'search';

let currentTab = $state<Tab>('monitor');
let pendingSessionId = $state<string | null>(null);
let pendingMessageOrdinal = $state<number | null>(null);
let pendingSessionNavigationVersion = $state(0);
let commandPaletteOpen = $state(false);

export function getTab(): Tab {
  return currentTab;
}

export function setTab(tab: Tab): void {
  currentTab = tab;
  commandPaletteOpen = false;
  if (typeof window !== 'undefined') {
    window.location.hash = tab === 'monitor' ? '' : tab;
  }
}

export function isCommandPaletteOpen(): boolean {
  return commandPaletteOpen;
}

export function openCommandPalette(): void {
  commandPaletteOpen = true;
}

export function closeCommandPalette(): void {
  commandPaletteOpen = false;
}

export function toggleCommandPalette(): void {
  commandPaletteOpen = !commandPaletteOpen;
}

export function navigateToSession(sessionId: string): void {
  pendingSessionId = sessionId;
  pendingMessageOrdinal = null;
  pendingSessionNavigationVersion += 1;
  setTab('sessions');
}

export function navigateToSessionMessage(sessionId: string, messageOrdinal: number): void {
  pendingSessionId = sessionId;
  pendingMessageOrdinal = messageOrdinal;
  pendingSessionNavigationVersion += 1;
  setTab('sessions');
}

export function getPendingSessionNavigationVersion(): number {
  return pendingSessionNavigationVersion;
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
  if (hash === 'live' || hash === 'sessions' || hash === 'pinned' || hash === 'analytics' || hash === 'usage' || hash === 'insights' || hash === 'search') {
    currentTab = hash;
  }
}

if (typeof window !== 'undefined') {
  initFromHash();
  window.addEventListener('hashchange', initFromHash);
}
