import type { Stats, AgentEvent, Session, FilterOptions, CostData, ToolStats, UsageMonitorData } from '../api/client';

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
export function handleEventForSession(event: AgentEvent): void {
  const idx = sessions.findIndex(s => s.id === event.session_id);
  if (idx >= 0) {
    sessions = sessions.map((s, i) => i === idx ? { ...s, last_event_at: event.created_at, status: 'active' } : s);
  } else {
    sessions = [{
      id: event.session_id,
      agent_id: event.agent_type,
      agent_type: event.agent_type,
      project: event.project,
      branch: event.branch,
      status: 'active',
      started_at: event.created_at,
      last_event_at: event.created_at,
    }, ...sessions];
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
