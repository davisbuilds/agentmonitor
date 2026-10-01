import { fetchSessionDetail, fetchLiveSessions, statsParams, type Stats, type AgentEvent, type Session, type FilterOptions, type CostData, type ToolStats, type QuotaMonitorData } from '../api/client';
import type { CostWindow } from '../monitor-analytics';
import { parseTimestamp } from '../format';
import { mergeSessionAggregates } from '../monitor-session-merge';
import { addEventUsage } from '../monitor-token-totals';

// --- Stats ---
let stats = $state<Stats>({
  total_events: 0,
  active_sessions: 0,
  live_sessions: 0,
  total_sessions: 0,
  active_agents: 0,
  total_tokens_in: 0,
  total_tokens_out: 0,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  total_cost_usd: 0,
  usage_by_agent: {},
  tool_breakdown: {},
  agent_breakdown: {},
  model_breakdown: {},
  branches: [],
});

export function getStats(): Stats { return stats; }
export function setStats(s: Stats): void { stats = s; }

let statsRefreshSignal = $state(0);
export function getStatsRefreshSignal(): number { return statsRefreshSignal; }
// Matching live events counted while a filtered stats read is in flight. The
// read's snapshot may predate them, so they are re-applied on top of it.
let eventsDuringFilteredRead: AgentEvent[] | null = null;
export function beginFilteredStatsRead(): void { eventsDuringFilteredRead = []; }
/** Apply a filtered read's snapshot, or abandon the read when `next` is null. */
export function endFilteredStatsRead(next: Stats | null): void {
  const arrived = eventsDuringFilteredRead ?? [];
  eventsDuringFilteredRead = null;
  if (!next) return;
  stats = arrived.reduce(
    (acc, event) => ({ ...addEventUsage(acc, event), total_events: acc.total_events + 1 }),
    next,
  );
}

/**
 * Apply the periodic SSE stats snapshot, which the server always computes
 * unfiltered. Under an agent or start-time filter it would replace the bar's
 * filtered totals with everyone's, so it is dropped and a filtered refresh is
 * requested instead.
 */
export function applyBroadcastStats(s: Stats): void {
  if (Object.keys(statsParams(filters)).length > 0) {
    statsRefreshSignal += 1;
    return;
  }
  stats = s;
}

// Whether the server runs an older build than the one on disk. It rides the
// stats snapshot but is not a stat: it applies whatever the Monitor's filters.
let serverBuildStale = $state(false);
export function getServerBuildStale(): boolean { return serverBuildStale; }
export function setServerBuild(build: Stats['server_build']): void {
  serverBuildStale = Boolean(build?.tracked && build.stale);
}

export function incrementEvent(event: AgentEvent): void {
  // A live event is new, so a start-time filter always admits it; an agent filter may not.
  const agent = statsParams(filters).agent;
  if (agent && event.agent_type !== agent) return;
  eventsDuringFilteredRead?.push(event);
  stats = { ...addEventUsage(stats, event), total_events: stats.total_events + 1 };
}

// --- Events ---
let events = $state<AgentEvent[]>([]);
export function getEvents(): AgentEvent[] { return events; }
export function setEvents(e: AgentEvent[]): void {
  // A reload (mount / auto-import / reconnect) replaces the feed with an
  // authoritative REST snapshot. But the resumed SSE handler can prepend a live
  // event newer than the snapshot while the query is in flight; a blind replace
  // would drop it. Preserve any current events newer than the snapshot's
  // high-water mark, then dedup by id (an event may appear in both the snapshot
  // and the live prepend) and keep the most-recent 200.
  const snapshotMaxId = e.reduce((max, ev) => Math.max(max, ev.id), 0);
  const newerLive = events.filter(ev => ev.id > snapshotMaxId);
  if (newerLive.length === 0) {
    events = e.slice(0, 200);
    return;
  }
  const byId = new Map<number, AgentEvent>();
  for (const ev of [...e, ...newerLive]) byId.set(ev.id, ev);
  events = Array.from(byId.values()).sort((a, b) => b.id - a.id).slice(0, 200);
}
export function addEvent(event: AgentEvent): void {
  events = [event, ...events].slice(0, 200);
}

// --- Sessions ---
let sessions = $state<Session[]>([]);
const sessionBackfillInFlight = new Set<string>();
const sessionBackfillRequestedAgain = new Set<string>();
// `complete` is false when the set began after the session already had edits
// (counted by the server, or held in a set the cap evicted); the server then
// owns the count, since this tab never saw those paths.
const editedFilesBySession = new Map<string, { files: Set<string>; complete: boolean }>();
export function getSessions(): Session[] { return sessions; }
export function setSessions(s: Session[]): void { sessions = s; }
/** Sessions whose edited-file set is held in memory; for tests. */
export function trackedEditedFileSessionCount(): number { return editedFilesBySession.size; }
// The SSE stream lives as long as the tab, so the file sets are capped, least
// recently edited first. Pruning by the visible list instead would forget a
// session an agent filter hides and later restores: its count could not grow
// until a fresh set passed the old aggregate.
export const EDITED_FILE_SESSION_CAP = 500;

// --- Context-window occupancy (v2 live projection, joined to v1 cards by id) ---
// Occupancy lives on the v2 browsing_sessions projection, not the v1 Session
// aggregate. Rather than mutate Session objects the event stream constantly
// rebuilds, we keep occupancy as a separate map keyed by session id and join it
// at render. Refreshed on the same signals that drive the monitor (mount,
// auto-import, session_parsed).
export interface SessionOccupancy { used: number | null; window: number | null; pct: number; }
let occupancyBySession = $state<Record<string, SessionOccupancy>>({});
export function getSessionOccupancy(id: string): SessionOccupancy | null {
  return occupancyBySession[id] ?? null;
}
// Codex browsing sessions are keyed by the rollout filename, but the v1 Monitor
// card is keyed by the embedded session UUID; alias occupancy under both so the
// card's id lookup resolves. Claude ids are already the UUID (self-alias, no-op).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export async function refreshOccupancy(): Promise<void> {
  try {
    // `/api/v2/live/sessions` clamps limit into [1, 500]; request the ceiling so
    // every displayed card gets its occupancy, not just the single newest row.
    const res = await fetchLiveSessions({ limit: 500 });
    const next: Record<string, SessionOccupancy> = {};
    for (const s of res.data) {
      if (s.context_pct == null) continue;
      const occ: SessionOccupancy = { used: s.context_used_tokens, window: s.context_window_tokens, pct: s.context_pct };
      next[s.id] = occ;
      const uuid = s.id.match(UUID_RE);
      if (uuid) next[uuid[0]] = occ;
    }
    occupancyBySession = next;
  } catch (err) {
    console.error('Failed to load session occupancy:', err);
  }
}
// Bumped when the server reports an auto-import brought in new events. The
// Monitor subscribes and refetches so importer-derived fields (e.g. a session's
// invocation `mode`, which the live hook/OTEL stream never carries) appear
// without a manual page reload.
let autoImportSignal = $state(0);
export function getAutoImportSignal(): number { return autoImportSignal; }

// Bumped when the SSE stream reconnects after a drop (e.g. laptop sleep). The v1
// `/api/stream` has no replay, so events emitted during the gap are lost from the
// incremental store; Monitor watches this signal and refetches authoritative
// state from REST to close the gap. Not bumped on the initial connect (mount
// already loads).
let reconnectSignal = $state(0);
export function getReconnectSignal(): number { return reconnectSignal; }
export function signalReconnect(): void { reconnectSignal++; }

export function handleSessionUpdate(update: Record<string, unknown>): void {
  if (update.type === 'idle_check') {
    sessions = sessions.map(s => {
      if (s.status === 'active') {
        const idle = Date.now() - parseTimestamp(s.last_event_at).getTime() > 5 * 60_000;
        return idle ? { ...s, status: 'idle' } : s;
      }
      return s;
    });
  } else if (update.type === 'auto_import' || update.type === 'resync') {
    autoImportSignal++;
  } else if (update.type === 'session_parsed' && typeof update.session_id === 'string') {
    // The watcher just parsed this session's file, which may have stamped
    // importer-derived fields (e.g. invocation `mode`). Refetch just this
    // session so the pill appears without reloading the whole dashboard.
    if (sessions.some((s) => s.id === update.session_id)) {
      void backfillSession(update.session_id);
      // The same parse updates the v2 occupancy projection; pull it so the
      // context pill tracks the latest turn without a manual reload.
      void refreshOccupancy();
    }
  }
}

function parseEventMetadata(event: AgentEvent): Record<string, unknown> {
  if (!event.metadata) return {};
  if (typeof event.metadata === 'string') {
    try {
      return JSON.parse(event.metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return event.metadata;
}

// Set when an edit adds a new path to an incomplete set: the local set cannot
// tell whether the path is already in the server's count, so ask the server.
let editCountNeedsRefetch = false;

/**
 * `countKnown` is false for a placeholder built from a live event: its zero
 * counts are not a baseline, since the backfill may reveal earlier files.
 */
function applyLiveEventAggregate(session: Session, event: AgentEvent, countKnown = true): Session {
  const metadata = parseEventMetadata(event);
  const nextStatus = event.event_type === 'session_end'
    ? (event.agent_type === 'claude_code' ? 'idle' : 'ended')
    : 'active';
  const next: Session = {
    ...session,
    last_event_at: event.created_at,
    status: nextStatus,
    project: event.project || session.project,
    branch: event.branch || session.branch,
    event_count: (session.event_count || 0) + 1,
    tokens_in: (session.tokens_in || 0) + (event.tokens_in || 0),
    tokens_out: (session.tokens_out || 0) + (event.tokens_out || 0),
    total_cost_usd: (session.total_cost_usd || 0) + (event.cost_usd || 0),
    lines_added: (session.lines_added || 0) + (typeof metadata.lines_added === 'number' ? metadata.lines_added : 0),
    lines_removed: (session.lines_removed || 0) + (typeof metadata.lines_removed === 'number' ? metadata.lines_removed : 0),
  };

  if (
    typeof metadata.file_path === 'string'
    && ['Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin'].includes(event.tool_name || '')
  ) {
    const entry = editedFilesBySession.get(session.id)
      ?? { files: new Set<string>(), complete: countKnown && (session.files_edited || 0) === 0 };
    const sizeBefore = entry.files.size;
    entry.files.add(metadata.file_path);
    if (!entry.complete && entry.files.size > sizeBefore) editCountNeedsRefetch = true;
    // Re-insert so Map order runs from least to most recently edited.
    editedFilesBySession.delete(session.id);
    editedFilesBySession.set(session.id, entry);
    if (editedFilesBySession.size > EDITED_FILE_SESSION_CAP) {
      const oldest = editedFilesBySession.keys().next().value;
      if (oldest !== undefined) editedFilesBySession.delete(oldest);
    }
    next.files_edited = Math.max(session.files_edited || 0, entry.files.size);
  }

  return next;
}

async function backfillSession(sessionId: string): Promise<void> {
  if (sessionBackfillInFlight.has(sessionId)) {
    // The running fetch may predate the edit that asked again; run once more.
    sessionBackfillRequestedAgain.add(sessionId);
    return;
  }
  sessionBackfillInFlight.add(sessionId);

  try {
    const detail = await fetchSessionDetail(sessionId, 0);
    sessions = sessions.map((session) => {
      if (session.id !== sessionId) return session;
      return mergeSessionAggregates(session, detail.session);
    });
  } catch (err) {
    console.error('Failed to backfill session aggregates:', err);
  } finally {
    sessionBackfillInFlight.delete(sessionId);
    if (sessionBackfillRequestedAgain.delete(sessionId)) void backfillSession(sessionId);
  }
}

export function handleEventForSession(event: AgentEvent): void {
  const idx = sessions.findIndex(s => s.id === event.session_id);
  if (idx >= 0) {
    editCountNeedsRefetch = false;
    sessions = sessions.map((s, i) => i === idx ? applyLiveEventAggregate(s, event) : s);
    if (editCountNeedsRefetch) void backfillSession(event.session_id);
  } else {
    sessions = [applyLiveEventAggregate({
      id: event.session_id,
      agent_id: event.agent_type,
      agent_type: event.agent_type,
      project: event.project,
      branch: event.branch,
      status: 'active',
      started_at: event.created_at,
      last_event_at: event.created_at,
      event_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      total_cost_usd: 0,
      files_edited: 0,
      lines_added: 0,
      lines_removed: 0,
    }, event, false), ...sessions];
    void backfillSession(event.session_id);
  }
}

// --- Filters ---
let filters = $state<Record<string, string>>({});
export function getFilters(): Record<string, string> { return filters; }
export function setFilters(f: Record<string, string>): void { filters = f; }

let filterOptions = $state<FilterOptions>({
  agent_types: [], event_types: [], tool_names: [], models: [], projects: [], branches: [], sources: [],
});
export function getFilterOptions(): FilterOptions { return filterOptions; }
export function setFilterOptions(o: FilterOptions): void { filterOptions = o; }

// --- Cost ---
let costData = $state<CostData | null>(null);
export function getCostData(): CostData | null { return costData; }
export function setCostData(d: CostData): void { costData = d; }
let costWindow = $state<CostWindow>('60d');
export function getCostWindow(): CostWindow { return costWindow; }
export function setCostWindow(window: CostWindow): void { costWindow = window; }

// --- Tools ---
let toolStats = $state<ToolStats | null>(null);
export function getToolStats(): ToolStats | null { return toolStats; }
export function setToolStats(t: ToolStats): void { toolStats = t; }

// --- Usage Monitor ---
let quotaMonitor = $state<QuotaMonitorData[]>([]);
export function getQuotaMonitor(): QuotaMonitorData[] { return quotaMonitor; }
export function setQuotaMonitor(u: QuotaMonitorData[]): void { quotaMonitor = u; }

// --- Connection ---
let connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('connecting');
export function getConnectionStatus() { return connectionStatus; }
export function setConnectionStatus(s: 'connected' | 'connecting' | 'disconnected'): void { connectionStatus = s; }

// --- Session detail ---
let selectedSessionId = $state<string | null>(null);
export function getSelectedSessionId(): string | null { return selectedSessionId; }
export function setSelectedSessionId(id: string | null): void { selectedSessionId = id; }
