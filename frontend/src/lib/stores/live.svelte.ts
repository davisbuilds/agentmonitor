import {
  ApiError,
  fetchLiveItems,
  fetchLiveSession,
  fetchLiveSettings,
  fetchLiveTurns,
  type LiveItem,
  type LiveSession,
  type LiveSettings,
  type LiveTurn,
} from '../api/client';
import { getMonitorSessionId } from './router.svelte';

// The live stream of the one session Monitor is following (an agent card's
// drill-in). There is no session list here: Monitor's agent cards are the list.

const LIVE_ITEMS_PAGE_SIZE = 100;

let selectedSessionId = $state<string | null>(null);
let selectedSession = $state<LiveSession | null>(null);
let sessionMissing = $state(false);
let sessionLoadFailed = $state(false);
let turns = $state<LiveTurn[]>([]);
let items = $state<LiveItem[]>([]);
let itemsTotal = $state(0);
// The stream opens at its newest page; this is where the next older page starts.
let itemsBeforeCursor = $state<string | undefined>();
let itemsLoading = $state(false);
let itemsError = $state<string | null>(null);
let selectedItemId = $state<number | null>(null);
let selectedKinds = $state<string[]>([]);

let connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('connecting');
let settings = $state<LiveSettings>({
  enabled: true,
  codex_mode: 'otel-only',
  capture: {
    prompts: true,
    reasoning: true,
    tool_arguments: true,
  },
  diff_payload_max_bytes: 32768,
});

let selectedRequestToken = 0;
let turnsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let metaRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let itemsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function itemKindsParam(): string | undefined {
  return selectedKinds.length > 0 ? selectedKinds.join(',') : undefined;
}

function dedupeItems(existing: LiveItem[], incoming: LiveItem[]): LiveItem[] {
  const seen = new Set(existing.map(item => item.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    merged.push(item);
    seen.add(item.id);
  }
  return merged;
}

async function loadSelectedSessionMeta(sessionId: string): Promise<void> {
  const token = selectedRequestToken;
  try {
    const session = await fetchLiveSession(sessionId);
    if (token !== selectedRequestToken || selectedSessionId !== sessionId) return;
    selectedSession = session;
    sessionMissing = false;
    sessionLoadFailed = false;
  } catch (err) {
    if (token !== selectedRequestToken || selectedSessionId !== sessionId) return;
    if (err instanceof ApiError && err.status === 404) {
      sessionMissing = true;
      return;
    }
    console.error('Failed to load live session:', err);
    // Keep a record that loaded earlier; only a session never loaded is failed.
    if (!selectedSession) sessionLoadFailed = true;
  }
}

async function loadSelectedTurns(sessionId: string): Promise<void> {
  const token = selectedRequestToken;
  try {
    const res = await fetchLiveTurns(sessionId);
    if (token !== selectedRequestToken || selectedSessionId !== sessionId) return;
    turns = res.data;
  } catch (err) {
    console.error('Failed to load live turns:', err);
  }
}

function keepSelectionInView(): void {
  if (selectedItemId == null || !items.some(item => item.id === selectedItemId)) {
    selectedItemId = items[items.length - 1]?.id ?? null;
  }
}

/**
 * Load the stream's items. `tail` (re)opens it at the newest page, `earlier`
 * prepends the page before the oldest item held, and `newer` appends whatever
 * arrived after the newest item held, a page at a time until caught up.
 */
async function loadSelectedItems(sessionId: string, mode: 'tail' | 'earlier' | 'newer'): Promise<void> {
  const token = selectedRequestToken;
  const current = () => token === selectedRequestToken && selectedSessionId === sessionId;
  itemsLoading = true;
  itemsError = null;
  try {
    if (mode === 'newer' && items.length > 0) {
      // A burst can exceed a page; follow the cursor until a page comes back short.
      for (let page = 0; page < 20; page += 1) {
        const res = await fetchLiveItems(sessionId, {
          limit: LIVE_ITEMS_PAGE_SIZE,
          cursor: String(items[items.length - 1].id),
          kinds: itemKindsParam(),
        });
        if (!current()) return;
        items = dedupeItems(items, res.data);
        itemsTotal = res.total;
        if (!res.cursor) break;
      }
    } else if (mode === 'earlier') {
      if (!itemsBeforeCursor) return;
      const res = await fetchLiveItems(sessionId, {
        limit: LIVE_ITEMS_PAGE_SIZE,
        before: itemsBeforeCursor,
        kinds: itemKindsParam(),
      });
      if (!current()) return;
      items = dedupeItems(res.data, items);
      itemsTotal = res.total;
      itemsBeforeCursor = res.before_cursor;
    } else {
      const res = await fetchLiveItems(sessionId, {
        limit: LIVE_ITEMS_PAGE_SIZE,
        tail: true,
        kinds: itemKindsParam(),
      });
      if (!current()) return;
      items = res.data;
      itemsTotal = res.total;
      itemsBeforeCursor = res.before_cursor;
    }
    keepSelectionInView();
  } catch (err) {
    console.error('Failed to load live items:', err);
    itemsError = 'Failed to load live items.';
  } finally {
    if (token === selectedRequestToken) itemsLoading = false;
  }
}

export async function initializeLiveSettings(): Promise<void> {
  try {
    settings = await fetchLiveSettings();
  } catch (err) {
    console.error('Failed to load live settings:', err);
  }
}

/** Start following one session's live stream, replacing any previous one. */
export async function followLiveSession(sessionId: string): Promise<void> {
  clearRefreshTimers();
  selectedSessionId = sessionId;
  selectedSession = null;
  sessionMissing = false;
  sessionLoadFailed = false;
  selectedRequestToken += 1;
  selectedItemId = null;
  itemsBeforeCursor = undefined;
  itemsTotal = 0;
  items = [];
  turns = [];
  itemsError = null;

  await Promise.all([
    loadSelectedSessionMeta(sessionId),
    loadSelectedTurns(sessionId),
    loadSelectedItems(sessionId, 'tail'),
  ]);
}

/** Stop following: drop the stream and any pending refresh. Settings stay. */
export function stopFollowingLiveSession(): void {
  clearRefreshTimers();
  selectedRequestToken += 1;
  selectedSessionId = null;
  selectedSession = null;
  sessionMissing = false;
  sessionLoadFailed = false;
  turns = [];
  items = [];
  itemsTotal = 0;
  itemsBeforeCursor = undefined;
  itemsLoading = false;
  itemsError = null;
  selectedItemId = null;
  selectedKinds = [];
  connectionStatus = 'connecting';
}

/** Load the page just older than the oldest item shown (scrolling up). */
export async function loadEarlierLiveItems(): Promise<void> {
  if (!selectedSessionId || !itemsBeforeCursor || itemsLoading) return;
  await loadSelectedItems(selectedSessionId, 'earlier');
}

/** Reopen the stream at its newest page, as after changing the kind filter. */
export async function refreshLiveItems(): Promise<void> {
  if (!selectedSessionId) return;
  itemsBeforeCursor = undefined;
  await loadSelectedItems(selectedSessionId, 'tail');
}

export function toggleLiveItemKind(kind: string): void {
  if (selectedKinds.includes(kind)) {
    selectedKinds = selectedKinds.filter(value => value !== kind);
  } else {
    selectedKinds = [...selectedKinds, kind];
  }
  void refreshLiveItems();
}

export function setSelectedLiveItem(id: number | null): void {
  selectedItemId = id;
}

export function setLiveConnectionStatus(status: 'connected' | 'connecting' | 'disconnected'): void {
  connectionStatus = status;
}

export function handleLiveEvent(message: { type: string; payload?: Record<string, unknown> }): void {
  const sessionId = typeof message.payload?.session_id === 'string' ? message.payload.session_id : null;

  if (message.type === 'connected') {
    setLiveConnectionStatus('connected');
    return;
  }
  if (!sessionId || sessionId !== selectedSessionId) return;

  switch (message.type) {
    case 'session_presence':
      scheduleMetaRefresh(sessionId);
      return;
    case 'turn_update':
      scheduleMetaRefresh(sessionId);
      scheduleTurnsRefresh(sessionId);
      return;
    case 'item_delta':
      scheduleMetaRefresh(sessionId);
      scheduleItemsRefresh(sessionId);
      return;
  }
}

function scheduleMetaRefresh(sessionId: string): void {
  if (metaRefreshTimer) clearTimeout(metaRefreshTimer);
  metaRefreshTimer = setTimeout(() => {
    void loadSelectedSessionMeta(sessionId);
  }, 120);
}

function scheduleTurnsRefresh(sessionId: string): void {
  if (turnsRefreshTimer) clearTimeout(turnsRefreshTimer);
  turnsRefreshTimer = setTimeout(() => {
    void loadSelectedTurns(sessionId);
  }, 120);
}

function scheduleItemsRefresh(sessionId: string): void {
  if (itemsRefreshTimer) clearTimeout(itemsRefreshTimer);
  itemsRefreshTimer = setTimeout(() => {
    void loadSelectedItems(sessionId, 'newer');
  }, 120);
}

function clearRefreshTimers(): void {
  if (turnsRefreshTimer) clearTimeout(turnsRefreshTimer);
  if (metaRefreshTimer) clearTimeout(metaRefreshTimer);
  if (itemsRefreshTimer) clearTimeout(itemsRefreshTimer);
  turnsRefreshTimer = null;
  metaRefreshTimer = null;
  itemsRefreshTimer = null;
}

export function getSelectedLiveSessionId(): string | null { return selectedSessionId; }
export function getSelectedLiveSession(): LiveSession | null { return selectedSession; }
/** True when the followed session has no live record (the API answered 404). */
export function getLiveSessionMissing(): boolean { return sessionMissing; }
/** True when the followed session's record failed to load for another reason. */
export function getLiveSessionLoadFailed(): boolean { return sessionLoadFailed; }
export function getLiveTurns(): LiveTurn[] { return turns; }
export function getLiveItems(): LiveItem[] { return items; }
export function getLiveItemsTotal(): number { return itemsTotal; }
/** True when older items exist before the oldest one shown. */
export function getLiveItemsHasEarlier(): boolean { return itemsBeforeCursor !== undefined; }
export function getLiveItemsLoading(): boolean { return itemsLoading; }
export function getLiveItemsError(): string | null { return itemsError; }
export function getSelectedLiveKinds(): string[] { return selectedKinds; }
export function getSelectedLiveItemId(): number | null { return selectedItemId; }
export function getSelectedLiveItem(): LiveItem | null {
  if (selectedItemId == null) return items[items.length - 1] ?? null;
  return items.find(item => item.id === selectedItemId) ?? null;
}
export function getLiveConnectionStatus(): 'connected' | 'connecting' | 'disconnected' { return connectionStatus; }
export function getLiveSettings(): LiveSettings { return settings; }
/**
 * The session Monitor shows a live stream for: the one in its route, while the
 * live view is on. With it off, Monitor shows the cards (and their filters).
 */
export function getFollowedLiveSessionId(): string | null {
  return settings.enabled ? getMonitorSessionId() : null;
}
