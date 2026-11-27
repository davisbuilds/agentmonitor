import { fetchSessionDetail, fetchLiveSessions, statsParams, type Stats, type AgentEvent, type Session, type FilterOptions, type QuotaMonitorData } from '../api/client';
import { parseTimestamp } from '../format';
import { mergeSessionAggregates } from '../monitor-session-merge';
import { addEventUsage } from '../monitor-token-totals';

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
// WHY: Apply events seen while the filtered query is in flight because its snapshot may predate them.
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

// WHY: Build freshness describes the server as a whole and should survive changes to the Monitor
// filters.
let serverBuildStale = $state(false);
export function getServerBuildStale(): boolean { return serverBuildStale; }
export function setServerBuild(build: Stats['server_build']): void {
  serverBuildStale = Boolean(build?.tracked && build.stale);
}

// WHY: Unknown rates are server state carried by the snapshot. Do not hide that warning when Monitor
// filters change.
let unpricedModels = $state<NonNullable<Stats['unpriced_models']>>([]);
export function getUnpricedModels(): NonNullable<Stats['unpriced_models']> { return unpricedModels; }
export function setUnpricedModels(models: Stats['unpriced_models']): void {
  unpricedModels = models ?? [];
}

// WHY: A start-time filter admits live events by definition. An agent filter can still exclude a
// different agent.
function matchesFilters(event: AgentEvent): boolean {
  const agent = statsParams(filters).agent;
  return !agent || event.agent_type === agent;
}

export function incrementEvent(event: AgentEvent): void {
  if (!matchesFilters(event)) return;
  eventsDuringFilteredRead?.push(event);
  stats = { ...addEventUsage(stats, event), total_events: stats.total_events + 1 };
}

let events = $state<AgentEvent[]>([]);
export function getEvents(): AgentEvent[] { return events; }
export function setEvents(e: AgentEvent[]): void {
  // WHY: A live event can arrive while REST loads. Keep arrivals newer than the snapshot, deduplicate
  // by ID and cap the combined feed.
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

let sessions = $state<Session[]>([]);
const sessionBackfillInFlight = new Set<string>();
const sessionBackfillRequestedAgain = new Set<string>();
// WHY: A local set started after a session had edits may omit earlier paths. Use the server total until
// the local set can prove its count.
const editedFilesBySession = new Map<string, { files: Set<string>; complete: boolean }>();
export function getSessions(): Session[] { return sessions; }
export function setSessions(s: Session[]): void { sessions = s; }
/** Sessions whose edited-file set is held in memory; for tests. */
export function trackedEditedFileSessionCount(): number { return editedFilesBySession.size; }
// WHY: Keep recent edit sets bounded across the life of the tab without discarding sets just because
// the current agent filter hides a session.
export const EDITED_FILE_SESSION_CAP = 500;

// WHY: Occupancy is a v2 projection. Join it by ID at render so v1 stream updates cannot overwrite it.
export interface SessionOccupancy { used: number | null; window: number | null; pct: number; }
let occupancyBySession = $state<Record<string, SessionOccupancy>>({});
export function getSessionOccupancy(id: string): SessionOccupancy | null {
  return occupancyBySession[id] ?? null;
}
// WHY: Alias Codex occupancy by rollout and embedded UUID because browsing and Monitor use different
// IDs for the same session.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export async function refreshOccupancy(): Promise<void> {
  try {
    // WHY: Request the endpoint ceiling so a short default page cannot omit occupancy for a displayed
    // card.
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
let autoImportSignal = $state(0);
export function getAutoImportSignal(): number { return autoImportSignal; }

// WHY: Signal only after reconnect, because the first mount loads its own snapshot and this SSE
// endpoint cannot replay missed events.
let reconnectSignal = $state(0);
export function getReconnectSignal(): number { return reconnectSignal; }
export function signalReconnect(): void { reconnectSignal++; }

/** The statuses an `idle_check` says the server's sweep left sessions in. */
function sweptStatuses(update: Record<string, unknown>): Map<string, 'idle' | 'ended'> | null {
  if (!Array.isArray(update.transitions)) return null;
  const statuses = new Map<string, 'idle' | 'ended'>();
  for (const entry of update.transitions as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const { session_id, status } = entry as Record<string, unknown>;
    if (typeof session_id === 'string' && (status === 'idle' || status === 'ended')) statuses.set(session_id, status);
  }
  return statuses;
}

/** Whether an active card has been quiet past the session timeout. */
function quietPast(session: Session, timeoutMinutes: number): boolean {
  return Date.now() - parseTimestamp(session.last_event_at).getTime() > timeoutMinutes * 60_000;
}

export function handleSessionUpdate(update: Record<string, unknown>): void {
  const swept = update.type === 'idle_check' ? sweptStatuses(update) : null;
  if (update.type === 'idle_check') {
    // WHY: Use the historical timeout for older server responses that lack the lifecycle metadata.
    const timeoutMinutes = typeof update.timeout_minutes === 'number' && update.timeout_minutes > 0
      ? update.timeout_minutes
      : 5;
    // WHY: Honor server transitions and infer idle for quiet cards when a sweep in another process
    // could not broadcast a transition.
    sessions = sessions
      .filter(s => swept?.get(s.id) !== 'ended')
      .map(s => {
        if (s.status !== 'active') return s;
        const idle = swept?.get(s.id) === 'idle' || quietPast(s, timeoutMinutes);
        return idle ? { ...s, status: 'idle' } : s;
      });
  } else if (update.type === 'auto_import' || update.type === 'resync' || update.type === 'hook_spool') {
    autoImportSignal++;
  } else if (update.type === 'session_parsed' && typeof update.session_id === 'string') {
    // WHY: Refetch the parsed session alone because it may gain metadata without changes to any other
    // card.
    if (sessions.some((s) => s.id === update.session_id)) {
      void backfillSession(update.session_id);
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

// WHY: Ask the server for the edit total if the local set may count a path that the server already
// observed.
let editCountNeedsRefetch = false;

/**
 * `countKnown` is false for a placeholder built from a live event: its zero
 * counts are not a baseline, since the backfill may reveal earlier files.
 */
function applyLiveEventAggregate(session: Session, event: AgentEvent, countKnown = true): Session {
  const metadata = parseEventMetadata(event);
  const nextStatus = event.event_type === 'session_end'
    ? (
      event.agent_type === 'claude_code'
        ? 'idle'
        : event.agent_type === 'antigravity' && event.source === 'import'
          ? 'active'
          : 'ended'
    )
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
    // WHY: Queue one more read because the request in flight may have started before the latest edit.
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

/** A live event from the SSE stream: the feed, its session's card, and the stats. */
export function applyLiveEvent(event: AgentEvent): void {
  if (!matchesFilters(event)) return;
  addEvent(event);
  handleEventForSession(event);
  incrementEvent(event);
}

let filters = $state<Record<string, string>>({});
export function getFilters(): Record<string, string> { return filters; }
export function setFilters(f: Record<string, string>): void { filters = f; }

let filterOptions = $state<FilterOptions>({
  agent_types: [], event_types: [], tool_names: [], models: [], projects: [], branches: [], sources: [],
});
export function getFilterOptions(): FilterOptions { return filterOptions; }
export function setFilterOptions(o: FilterOptions): void { filterOptions = o; }

// WHY: Use the Usage API’s windows so both cost displays can be compared directly.
export interface MonitorCostWindowTotals {
  today: number | null;
  last30Days: number | null;
}
let costWindows = $state<MonitorCostWindowTotals>({ today: null, last30Days: null });
export function getCostWindows(): MonitorCostWindowTotals { return costWindows; }
export function setCostWindows(next: MonitorCostWindowTotals): void { costWindows = next; }

let quotaMonitor = $state<QuotaMonitorData[]>([]);
export function getQuotaMonitor(): QuotaMonitorData[] { return quotaMonitor; }
export function setQuotaMonitor(u: QuotaMonitorData[]): void { quotaMonitor = u; }

let connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('connecting');
export function getConnectionStatus() { return connectionStatus; }
export function setConnectionStatus(s: 'connected' | 'connecting' | 'disconnected'): void { connectionStatus = s; }
