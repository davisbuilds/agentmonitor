import {
  buildMonitorHash,
  buildSessionsHash,
  canonicalizeLegacyAnalyticsHash,
  canonicalizeLegacyLiveHash,
  canonicalizeLegacyPinnedHash,
  canonicalizeLegacySearchHash,
  defaultSessionsRouteState,
  parseAppHash,
  parseMonitorSessionId,
  type AppTab,
} from '../route-state';

export type Tab = AppTab;

let currentTab = $state<Tab>('monitor');
let monitorSessionId = $state<string | null>(null);
let pendingSessionId = $state<string | null>(null);
let pendingMessageOrdinal = $state<number | null>(null);
let pendingSessionNavigationVersion = $state(0);
let commandPaletteOpen = $state(false);

export function getTab(): Tab {
  return currentTab;
}

export function setTab(tab: Tab): void {
  const leavingDrillIn = monitorSessionId !== null;
  currentTab = tab;
  monitorSessionId = null;
  commandPaletteOpen = false;
  if (typeof window !== 'undefined') {
    if (parseAppHash(window.location.hash).tab === tab && !leavingDrillIn) return;
    const nextHash = tab === 'monitor' ? '' : tab;
    window.location.hash = nextHash;
  }
}

/** The session Monitor is following in its live stream, from `#monitor?session=…`. */
export function getMonitorSessionId(): string | null {
  return monitorSessionId;
}

export function openMonitorSession(sessionId: string): void {
  currentTab = 'monitor';
  monitorSessionId = sessionId;
  commandPaletteOpen = false;
  if (typeof window !== 'undefined') {
    window.location.hash = buildMonitorHash(sessionId);
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
    window.location.hash = buildSessionsHash({ ...defaultSessionsRouteState(), sessionId });
  }
}

export function navigateToSessionMessage(sessionId: string, messageOrdinal: number): void {
  pendingSessionId = sessionId;
  pendingMessageOrdinal = messageOrdinal;
  pendingSessionNavigationVersion += 1;
  currentTab = 'sessions';
  commandPaletteOpen = false;
  if (typeof window !== 'undefined') {
    window.location.hash = buildSessionsHash({ ...defaultSessionsRouteState(), sessionId, messageOrdinal });
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

function initFromHash(): void {
  if (typeof window === 'undefined') return;
  // WHY: Replace legacy hashes in place so Back cannot return to an obsolete link and redirect again.
  // Apply the replacement in this pass because replaceState emits no hashchange.
  const canonical = canonicalizeLegacyAnalyticsHash(window.location.hash)
    ?? canonicalizeLegacyPinnedHash(window.location.hash)
    ?? canonicalizeLegacySearchHash(window.location.hash)
    ?? canonicalizeLegacyLiveHash(window.location.hash);
  if (canonical !== null) {
    window.history.replaceState(null, '', `#${canonical}`);
  }
  currentTab = parseAppHash(window.location.hash).tab;
  monitorSessionId = parseMonitorSessionId(window.location.hash);
}

if (typeof window !== 'undefined') {
  initFromHash();
  window.addEventListener('hashchange', initFromHash);
}
