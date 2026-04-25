import { buildSessionsHash, parseAppHash, type AppTab } from '../route-state';

export type Tab = AppTab;

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
    if (parseAppHash(window.location.hash).tab === tab) return;
    const nextHash = tab === 'monitor' ? '' : tab;
    window.location.hash = nextHash;
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
  currentTab = 'sessions';
  commandPaletteOpen = false;
  if (typeof window !== 'undefined') {
    window.location.hash = buildSessionsHash({
      project: '',
      agent: '',
      sessionId,
      messageOrdinal: null,
    });
  }
}

export function navigateToSessionMessage(sessionId: string, messageOrdinal: number): void {
  pendingSessionId = sessionId;
  pendingMessageOrdinal = messageOrdinal;
  pendingSessionNavigationVersion += 1;
  currentTab = 'sessions';
  commandPaletteOpen = false;
  if (typeof window !== 'undefined') {
    window.location.hash = buildSessionsHash({
      project: '',
      agent: '',
      sessionId,
      messageOrdinal,
    });
  }
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
  currentTab = parseAppHash(window.location.hash).tab;
}

if (typeof window !== 'undefined') {
  initFromHash();
  window.addEventListener('hashchange', initFromHash);
}
