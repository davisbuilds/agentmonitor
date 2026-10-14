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

// The live stream of the one session Monitor is following (an agent card's
// drill-in). There is no session list here: Monitor's agent cards are the list.

const LIVE_ITEMS_PAGE_SIZE = 100;

let selectedSessionId = $state<string | null>(null);
let selectedSession = $state<LiveSession | null>(null);
let sessionMissing = $state(false);
let turns = $state<LiveTurn[]>([]);
let items = $state<LiveItem[]>([]);
let itemsTotal = $state(0);
let itemsCursor = $state<string | undefined>();
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
  } catch (err) {
    if (token !== selectedRequestToken || selectedSessionId !== sessionId) return;
    if (err instanceof ApiError && err.status === 404) {
      sessionMissing = true;
      return;
    }
    console.error('Failed to load live session:', err);
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

async function loadSelectedItems(sessionId: string, append = false): Promise<void> {
  const token = selectedRequestToken;
  itemsLoading = true;
  itemsError = null;
  try {
    const res = await fetchLiveItems(sessionId, {
      limit: LIVE_ITEMS_PAGE_SIZE,
      cursor: append ? itemsCursor : undefined,
      kinds: itemKindsParam(),
    });
    if (token !== selectedRequestToken || selectedSessionId !== sessionId) return;

    items = append ? dedupeItems(items, res.data) : res.data;
    itemsTotal = res.total;
    itemsCursor = res.cursor;

    if (selectedItemId != null && !items.some(item => item.id === selectedItemId)) {
      selectedItemId = items[items.length - 1]?.id ?? null;
    } else if (selectedItemId == null) {
      selectedItemId = items[items.length - 1]?.id ?? null;
    }
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
  selectedRequestToken += 1;
  selectedItemId = null;
  itemsCursor = undefined;
  itemsTotal = 0;
  items = [];
  turns = [];
  itemsError = null;

  await Promise.all([
    loadSelectedSessionMeta(sessionId),
    loadSelectedTurns(sessionId),
    loadSelectedItems(sessionId),
  ]);
}

/** Stop following: drop the stream and any pending refresh. Settings stay. */
export function stopFollowingLiveSession(): void {
  clearRefreshTimers();
  selectedRequestToken += 1;
  selectedSessionId = null;
  selectedSession = null;
  sessionMissing = false;
  turns = [];
  items = [];
  itemsTotal = 0;
  itemsCursor = undefined;
  itemsLoading = false;
  itemsError = null;
  selectedItemId = null;
  selectedKinds = [];
  connectionStatus = 'connecting';
}

export async function loadMoreLiveItems(): Promise<void> {
  if (!selectedSessionId || !itemsCursor || itemsLoading) return;
  await loadSelectedItems(selectedSessionId, true);
}

export async function refreshLiveItems(): Promise<void> {
  if (!selectedSessionId) return;
  itemsCursor = undefined;
  await loadSelectedItems(selectedSessionId, false);
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
    void loadSelectedItems(sessionId, true);
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
export function getLiveTurns(): LiveTurn[] { return turns; }
export function getLiveItems(): LiveItem[] { return items; }
export function getLiveItemsTotal(): number { return itemsTotal; }
export function getLiveItemsHasMore(): boolean { return !!itemsCursor && items.length < itemsTotal; }
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
