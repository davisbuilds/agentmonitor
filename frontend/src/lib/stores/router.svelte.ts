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
  // The Monitor tab is also the way back from a followed session to the cards.
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

// Initialize from URL hash
function initFromHash(): void {
  if (typeof window === 'undefined') return;
  // Rewrite legacy deep links to their canonical consolidated form (#usage /
  // #insights → #analytics?view=…, #pinned and #sessions?view=pinned →
  // #sessions?pinned=1, #search?q=… → #sessions?q=…, #live → Monitor). Use
  // replaceState (not location.hash =) so the rewrite adds no history entry —
  // otherwise Back returns to the legacy hash and immediately re-redirects,
  // trapping the user. replaceState fires no hashchange, so we read the
  // canonical hash and set the tab in this same pass.
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
