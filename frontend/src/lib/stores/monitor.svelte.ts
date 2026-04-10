import { fetchSessionDetail, type Stats, type AgentEvent, type Session, type FilterOptions, type CostData, type ToolStats, type UsageMonitorData } from '../api/client';
import type { CostWindow } from '../monitor-analytics';

// --- Stats ---
let stats = $state<Stats>({
  total_events: 0,
  active_sessions: 0,
  live_sessions: 0,
  total_sessions: 0,
  active_agents: 0,
  total_tokens_in: 0,
  total_tokens_out: 0,
  total_cost_usd: 0,
  tool_breakdown: {},
  agent_breakdown: {},
  model_breakdown: {},
  branches: [],
});

export function getStats(): Stats { return stats; }
export function setStats(s: Stats): void { stats = s; }
export function incrementEvent(event: AgentEvent): void {
  stats = {
    ...stats,
    total_events: stats.total_events + 1,
    total_tokens_in: stats.total_tokens_in + (event.tokens_in || 0),
    total_tokens_out: stats.total_tokens_out + (event.tokens_out || 0),
    total_cost_usd: stats.total_cost_usd + (event.cost_usd || 0),
  };
}

// --- Events ---
let events = $state<AgentEvent[]>([]);
export function getEvents(): AgentEvent[] { return events; }
export function setEvents(e: AgentEvent[]): void { events = e; }
export function addEvent(event: AgentEvent): void {
  events = [event, ...events].slice(0, 200);
}

// --- Sessions ---
let sessions = $state<Session[]>([]);
const sessionBackfillInFlight = new Set<string>();
const editedFilesBySession = new Map<string, Set<string>>();
export function getSessions(): Session[] { return sessions; }
export function setSessions(s: Session[]): void { sessions = s; }
export function handleSessionUpdate(update: Record<string, unknown>): void {
  if (update.type === 'idle_check') {
    sessions = sessions.map(s => {
      if (s.status === 'active') {
        const idle = Date.now() - new Date(s.last_event_at).getTime() > 5 * 60_000;
        return idle ? { ...s, status: 'idle' } : s;
      }
      return s;
    });
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

function applyLiveEventAggregate(session: Session, event: AgentEvent): Session {
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
    const files = editedFilesBySession.get(session.id) || new Set<string>();
    files.add(metadata.file_path);
    editedFilesBySession.set(session.id, files);
    next.files_edited = Math.max(session.files_edited || 0, files.size);
  }

  return next;
}

function mergeSessionAggregates(current: Session, incoming: Session): Session {
  return {
    ...current,
    ...incoming,
    status: current.status === 'active' ? 'active' : incoming.status,
    project: current.project || incoming.project,
    branch: current.branch || incoming.branch,
    started_at: incoming.started_at || current.started_at,
    last_event_at: current.last_event_at || incoming.last_event_at,
    event_count: Math.max(current.event_count || 0, incoming.event_count || 0),
    tokens_in: Math.max(current.tokens_in || 0, incoming.tokens_in || 0),
    tokens_out: Math.max(current.tokens_out || 0, incoming.tokens_out || 0),
    total_cost_usd: Math.max(current.total_cost_usd || 0, incoming.total_cost_usd || 0),
    files_edited: Math.max(current.files_edited || 0, incoming.files_edited || 0),
    lines_added: Math.max(current.lines_added || 0, incoming.lines_added || 0),
    lines_removed: Math.max(current.lines_removed || 0, incoming.lines_removed || 0),
  };
}

async function backfillSession(sessionId: string): Promise<void> {
  if (sessionBackfillInFlight.has(sessionId)) return;
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
  }
}

export function handleEventForSession(event: AgentEvent): void {
  const idx = sessions.findIndex(s => s.id === event.session_id);
  if (idx >= 0) {
    sessions = sessions.map((s, i) => i === idx ? applyLiveEventAggregate(s, event) : s);
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
    }, event), ...sessions];
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
let usageMonitor = $state<UsageMonitorData[]>([]);
export function getUsageMonitor(): UsageMonitorData[] { return usageMonitor; }
export function setUsageMonitor(u: UsageMonitorData[]): void { usageMonitor = u; }

// --- Connection ---
let connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('connecting');
export function getConnectionStatus() { return connectionStatus; }
export function setConnectionStatus(s: 'connected' | 'connecting' | 'disconnected'): void { connectionStatus = s; }

// --- Session detail ---
let selectedSessionId = $state<string | null>(null);
export function getSelectedSessionId(): string | null { return selectedSessionId; }
export function setSelectedSessionId(id: string | null): void { selectedSessionId = id; }
