import {
  fetchLiveItems,
  fetchLiveSession,
  fetchLiveSessions,
  fetchLiveSettings,
  fetchLiveTurns,
  fetchV2Agents,
  fetchV2Projects,
  type LiveItem,
  type LiveSession,
  type LiveSettings,
  type LiveTurn,
} from '../api/client';

export interface LiveFilters {
  project: string;
  agent: string;
  live_status: string;
  fidelity: string;
  active_only: boolean;
}

const LIVE_PAGE_SIZE = 50;
const LIVE_ITEMS_PAGE_SIZE = 100;

let sessions = $state<LiveSession[]>([]);
let sessionsTotal = $state(0);
let sessionsCursor = $state<string | undefined>();
let sessionsLoading = $state(false);
let sessionsError = $state<string | null>(null);

let projects = $state<string[]>([]);
let agents = $state<string[]>([]);
let filters = $state<LiveFilters>({
  project: '',
  agent: '',
  live_status: '',
  fidelity: '',
  active_only: true,
});

let selectedSessionId = $state<string | null>(null);
let selectedSession = $state<LiveSession | null>(null);
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

let sessionsRequestToken = 0;
let selectedRequestToken = 0;
let sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
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

function syncSelectedSessionFromList(): void {
  if (!selectedSessionId) return;
  const next = sessions.find(session => session.id === selectedSessionId);
  if (next) selectedSession = next;
}

async function loadSelectedSessionMeta(sessionId: string): Promise<void> {
  const token = selectedRequestToken;
  try {
    const session = await fetchLiveSession(sessionId);
    if (token !== selectedRequestToken || selectedSessionId !== sessionId) return;
    selectedSession = session;
  } catch (err) {
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

export async function initializeLivePage(): Promise<void> {
  const [settingsRes, projectsRes, agentsRes] = await Promise.all([
    fetchLiveSettings().catch(() => settings),
    fetchV2Projects().catch(() => ({ data: [] })),
    fetchV2Agents().catch(() => ({ data: [] })),
  ]);

  settings = settingsRes;
  projects = projectsRes.data;
  agents = agentsRes.data;

  if (!settings.enabled) return;
  await loadLiveSessions();
}

export async function initializeLiveSettings(): Promise<void> {
  try {
    settings = await fetchLiveSettings();
  } catch (err) {
    console.error('Failed to load live settings:', err);
  }
}

export async function loadLiveSessions(append = false): Promise<void> {
  const token = ++sessionsRequestToken;
  sessionsLoading = true;
  sessionsError = null;

  try {
    const params: Record<string, string | number | boolean> = { limit: LIVE_PAGE_SIZE };
    if (filters.project) params.project = filters.project;
    if (filters.agent) params.agent = filters.agent;
    if (filters.live_status) params.live_status = filters.live_status;
    if (filters.fidelity) params.fidelity = filters.fidelity;
    if (filters.active_only) params.active_only = true;
    if (append && sessionsCursor) params.cursor = sessionsCursor;

    const res = await fetchLiveSessions(params);
    if (token !== sessionsRequestToken) return;

    sessions = append ? [...sessions, ...res.data] : res.data;
    sessionsTotal = res.total;
    sessionsCursor = res.cursor;

    syncSelectedSessionFromList();

    if (!selectedSessionId && sessions[0]) {
      await selectLiveSession(sessions[0].id);
      return;
    }

    if (!append && selectedSessionId && !sessions.some(session => session.id === selectedSessionId) && sessions[0]) {
      await selectLiveSession(sessions[0].id);
      return;
    }
  } catch (err) {
    console.error('Failed to load live sessions:', err);
    sessionsError = 'Failed to load live sessions.';
  } finally {
    if (token === sessionsRequestToken) sessionsLoading = false;
  }
}

export async function selectLiveSession(sessionId: string): Promise<void> {
  selectedSessionId = sessionId;
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

export async function loadMoreLiveSessions(): Promise<void> {
  if (!sessionsCursor || sessionsLoading) return;
  await loadLiveSessions(true);
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

export function setLiveFilters(next: Partial<LiveFilters>): void {
  filters = { ...filters, ...next };
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

  switch (message.type) {
    case 'connected':
      setLiveConnectionStatus('connected');
      return;
    case 'session_presence':
      scheduleSessionsRefresh();
      if (sessionId && sessionId === selectedSessionId) scheduleMetaRefresh(sessionId);
      return;
    case 'turn_update':
      scheduleSessionsRefresh();
      if (sessionId && sessionId === selectedSessionId) scheduleTurnsRefresh(sessionId);
      return;
    case 'item_delta':
      scheduleSessionsRefresh();
      if (sessionId && sessionId === selectedSessionId) scheduleItemsRefresh(sessionId);
      return;
  }
}

function scheduleSessionsRefresh(): void {
  if (sessionsRefreshTimer) clearTimeout(sessionsRefreshTimer);
  sessionsRefreshTimer = setTimeout(() => {
    void loadLiveSessions();
  }, 150);
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

export function resetLiveState(): void {
  if (sessionsRefreshTimer) clearTimeout(sessionsRefreshTimer);
  if (turnsRefreshTimer) clearTimeout(turnsRefreshTimer);
  if (metaRefreshTimer) clearTimeout(metaRefreshTimer);
  if (itemsRefreshTimer) clearTimeout(itemsRefreshTimer);
  sessionsRefreshTimer = null;
  turnsRefreshTimer = null;
  metaRefreshTimer = null;
  itemsRefreshTimer = null;
  sessions = [];
  sessionsTotal = 0;
  sessionsCursor = undefined;
  sessionsLoading = false;
  sessionsError = null;
  projects = [];
  agents = [];
  filters = {
    project: '',
    agent: '',
    live_status: '',
    fidelity: '',
    active_only: true,
  };
  selectedSessionId = null;
  selectedSession = null;
  turns = [];
  items = [];
  itemsTotal = 0;
  itemsCursor = undefined;
  itemsLoading = false;
  itemsError = null;
  selectedItemId = null;
  selectedKinds = [];
  connectionStatus = 'connecting';
  settings = {
    enabled: true,
    codex_mode: 'otel-only',
    capture: {
      prompts: true,
      reasoning: true,
      tool_arguments: true,
    },
    diff_payload_max_bytes: 32768,
  };
}

export function getLiveSessions(): LiveSession[] { return sessions; }
export function getLiveSessionsTotal(): number { return sessionsTotal; }
export function getLiveSessionsHasMore(): boolean { return !!sessionsCursor && sessions.length < sessionsTotal; }
export function getLiveSessionsLoading(): boolean { return sessionsLoading; }
export function getLiveSessionsError(): string | null { return sessionsError; }
export function getLiveProjects(): string[] { return projects; }
export function getLiveAgents(): string[] { return agents; }
export function getLiveFilters(): LiveFilters { return filters; }
export function getSelectedLiveSessionId(): string | null { return selectedSessionId; }
export function getSelectedLiveSession(): LiveSession | null { return selectedSession; }
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
