// --- V1 API types (existing Monitor tab) ---

export interface Stats {
  total_events: number;
  active_sessions: number;
  live_sessions: number;
  total_sessions: number;
  active_agents: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  tool_breakdown: Record<string, number>;
  agent_breakdown: Record<string, number>;
  model_breakdown: Record<string, number>;
  branches: string[];
  usage_monitor?: UsageMonitorData[];
}

export interface UsageMonitorData {
  agent_type: string;
  limitType: 'tokens' | 'cost';
  session: { used: number; limit: number; windowHours: number };
  extended: { used: number; limit: number; windowHours: number } | null;
  weekly: { used: number; limit: number; windowHours: number } | null;
}

export interface AgentEvent {
  id: number;
  event_id?: string;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name?: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  model?: string;
  cost_usd?: number;
  project?: string;
  branch?: string;
  duration_ms?: number;
  created_at: string;
  client_timestamp?: string;
  metadata?: Record<string, unknown> | string;
  source?: string;
}

export interface Session {
  id: string;
  agent_id: string;
  agent_type: string;
  project?: string;
  branch?: string;
  status: string;
  started_at: string;
  ended_at?: string;
  last_event_at: string;
  metadata?: Record<string, unknown> | string;
  event_count?: number;
  tokens_in?: number;
  tokens_out?: number;
  total_cost_usd?: number;
  files_edited?: number;
  lines_added?: number;
  lines_removed?: number;
}

export interface CostData {
  timeline: Array<{ date: string; cost: number }>;
  by_project: Array<{ project: string; cost: number; session_count: number; event_count: number }>;
  by_model: Array<{ model: string; cost: number }>;
}

export interface ToolStats {
  tools: Array<{
    tool_name: string;
    total_calls: number;
    error_count: number;
    error_rate: number;
    avg_duration_ms: number;
    by_agent: Record<string, number>;
  }>;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface FilterOptions {
  agent_types: string[];
  event_types: string[];
  tool_names: string[];
  models: string[];
  projects: string[];
  branches: SelectOption[];
  sources: string[];
}

// --- V2 API types (Session browser) ---

export type SessionCapabilityLevel = 'none' | 'summary' | 'full';

export interface SessionCapabilities {
  history: SessionCapabilityLevel;
  search: SessionCapabilityLevel;
  tool_analytics: SessionCapabilityLevel;
  live_items: SessionCapabilityLevel;
}

export interface BrowsingSession {
  id: string;
  project: string | null;
  agent: string;
  first_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  user_message_count: number;
  parent_session_id: string | null;
  relationship_type: string | null;
  capabilities: SessionCapabilities | null;
  integration_mode: string | null;
  fidelity: string | null;
}

export interface LiveSession extends BrowsingSession {
  live_status: string | null;
  last_item_at: string | null;
  file_path: string | null;
  file_size: number | null;
  file_hash: string | null;
}

export interface LiveTurn {
  id: number;
  session_id: string;
  agent_type: string;
  source_turn_id: string | null;
  status: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface LiveItem {
  id: number;
  session_id: string;
  turn_id: number | null;
  ordinal: number;
  source_item_id: string | null;
  kind: string;
  status: string | null;
  payload_json: string;
  created_at: string | null;
}

export interface LiveSettings {
  enabled: boolean;
  codex_mode: 'otel-only' | 'exporter';
  capture: {
    prompts: boolean;
    reasoning: boolean;
    tool_arguments: boolean;
  };
  diff_payload_max_bytes: number;
}

export interface Message {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content: string; // JSON string of content blocks
  timestamp: string | null;
  has_thinking: number;
  has_tool_use: number;
  content_length: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
  tool_use_id?: string;
}

export interface SearchResult {
  session_id: string;
  message_id: number;
  message_ordinal: number;
  message_role: string;
  snippet: string;
}

export interface AnalyticsSummary {
  total_sessions: number;
  total_messages: number;
  total_user_messages: number;
  daily_average_sessions: number;
  daily_average_messages: number;
  date_range: { earliest: string | null; latest: string | null };
  coverage: AnalyticsCoverage;
}

export interface ActivityDataPoint {
  date: string;
  sessions: number;
  messages: number;
  user_messages: number;
}

export interface ProjectBreakdown {
  project: string;
  session_count: number;
  message_count: number;
  user_message_count: number;
}

export interface ToolUsageStat {
  tool_name: string;
  category: string | null;
  count: number;
}

export interface AnalyticsCapabilityBreakdown {
  full: number;
  summary: number;
  none: number;
  unknown: number;
}

export interface AnalyticsCoverage {
  metric_scope: 'all_sessions' | 'tool_analytics_capable';
  matching_sessions: number;
  included_sessions: number;
  excluded_sessions: number;
  fidelity_breakdown: {
    full: number;
    summary: number;
    unknown: number;
  };
  capability_breakdown: {
    history: AnalyticsCapabilityBreakdown;
    search: AnalyticsCapabilityBreakdown;
    tool_analytics: AnalyticsCapabilityBreakdown;
    live_items: AnalyticsCapabilityBreakdown;
  };
  note: string;
}

export interface HourOfWeekDataPoint {
  day_of_week: number;
  hour_of_day: number;
  session_count: number;
  message_count: number;
  user_message_count: number;
}

export interface TopSessionStat {
  id: string;
  project: string | null;
  agent: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  user_message_count: number;
  tool_call_count: number;
  fidelity: string | null;
}

export interface VelocityMetrics {
  total_sessions: number;
  total_messages: number;
  total_user_messages: number;
  active_days: number;
  span_days: number;
  sessions_per_active_day: number;
  messages_per_active_day: number;
  sessions_per_calendar_day: number;
  messages_per_calendar_day: number;
  average_messages_per_session: number;
  average_user_messages_per_session: number;
  coverage: AnalyticsCoverage;
}

export interface AgentComparisonRow {
  agent: string;
  session_count: number;
  message_count: number;
  user_message_count: number;
  average_messages_per_session: number;
  full_fidelity_sessions: number;
  summary_fidelity_sessions: number;
  tool_analytics_capable_sessions: number;
  first_started_at: string | null;
  last_started_at: string | null;
}

export interface UsageSourceBreakdown {
  source: string;
  event_count: number;
  usage_event_count: number;
  session_count: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface UsageCoverage {
  metric_scope: 'event_usage';
  matching_events: number;
  usage_events: number;
  missing_usage_events: number;
  matching_sessions: number;
  usage_sessions: number;
  sources_with_usage: number;
  source_breakdown: UsageSourceBreakdown[];
  note: string;
}

export interface UsageSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_usage_events: number;
  total_sessions: number;
  active_days: number;
  span_days: number;
  average_cost_per_active_day: number;
  average_cost_per_session: number;
  peak_day: {
    date: string | null;
    cost_usd: number;
  };
  coverage: UsageCoverage;
}

export interface UsageDailyPoint {
  date: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
  session_count: number;
}

export interface UsageProjectBreakdown {
  project: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
  session_count: number;
}

export interface UsageModelBreakdown {
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
  session_count: number;
}

export interface UsageAgentBreakdown {
  agent: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
  session_count: number;
}

export interface UsageTopSessionRow {
  id: string;
  project: string | null;
  agent: string;
  started_at: string | null;
  ended_at: string | null;
  last_activity_at: string | null;
  message_count: number | null;
  user_message_count: number | null;
  fidelity: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  event_count: number;
  usage_events: number;
  browsing_session_available: boolean;
}

// --- API client ---

type Filters = Record<string, string>;

interface RawCostData {
  timeline?: Array<{ bucket: string; cost_usd: number }>;
  by_project?: Array<{ project: string; cost_usd: number; session_count?: number; event_count?: number }>;
  by_model?: Array<{ model: string; cost_usd: number }>;
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

async function checkedJson<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${context} failed (${res.status}): ${body}`);
  }
  return res.json();
}

// V1 endpoints (Monitor tab)

export async function fetchStats(filters: Filters = {}): Promise<Stats> {
  const res = await fetch(`/api/stats${qs(filters)}`);
  return checkedJson(res, 'fetchStats');
}

export async function fetchEvents(filters: Filters = {}, limit = 100): Promise<{ events: AgentEvent[]; total: number }> {
  const res = await fetch(`/api/events${qs({ ...filters, limit })}`);
  return checkedJson(res, 'fetchEvents');
}

export async function fetchSessions(filters: Filters = {}): Promise<{ sessions: Session[]; total: number }> {
  const res = await fetch(`/api/sessions${qs(filters)}`);
  return checkedJson(res, 'fetchSessions');
}

export async function fetchFilterOptions(): Promise<FilterOptions> {
  const res = await fetch('/api/filter-options');
  return checkedJson(res, 'fetchFilterOptions');
}

export async function fetchCostData(filters: Filters = {}): Promise<CostData> {
  const res = await fetch(`/api/stats/cost${qs(filters)}`);
  const data = await checkedJson<RawCostData>(res, 'fetchCostData');
  return {
    timeline: Array.isArray(data.timeline)
      ? data.timeline.map((item) => ({
          date: item.bucket,
          cost: item.cost_usd,
        }))
      : [],
    by_project: Array.isArray(data.by_project)
      ? data.by_project.map((item) => ({
          project: item.project,
          cost: item.cost_usd,
          session_count: item.session_count ?? 0,
          event_count: item.event_count ?? 0,
        }))
      : [],
    by_model: Array.isArray(data.by_model)
      ? data.by_model.map((item) => ({
          model: item.model,
          cost: item.cost_usd,
        }))
      : [],
  };
}

export async function fetchToolStats(filters: Filters = {}): Promise<ToolStats> {
  const res = await fetch(`/api/stats/tools${qs(filters)}`);
  return checkedJson(res, 'fetchToolStats');
}

export async function fetchSessionDetail(id: string, eventLimit = 10): Promise<{ session: Session; events: AgentEvent[] }> {
  const res = await fetch(`/api/sessions/${id}?event_limit=${eventLimit}`);
  return checkedJson(res, 'fetchSessionDetail');
}

export async function fetchTranscript(id: string): Promise<{ transcript: Array<{ role: string; content: string; timestamp?: string }> }> {
  const res = await fetch(`/api/sessions/${id}/transcript`);
  return checkedJson(res, 'fetchTranscript');
}

// V2 endpoints (Session browser)

export async function fetchBrowsingSessions(params: Record<string, string | number | undefined> = {}): Promise<{ data: BrowsingSession[]; total: number; cursor?: string }> {
  const res = await fetch(`/api/v2/sessions${qs(params)}`);
  return checkedJson(res, 'fetchBrowsingSessions');
}

export async function fetchBrowsingSession(id: string): Promise<BrowsingSession> {
  const res = await fetch(`/api/v2/sessions/${id}`);
  return checkedJson(res, 'fetchBrowsingSession');
}

export async function fetchMessages(sessionId: string, params: { offset?: number; limit?: number } = {}): Promise<{ data: Message[]; total: number }> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/messages${qs(params)}`);
  return checkedJson(res, 'fetchMessages');
}

export async function fetchSessionChildren(id: string): Promise<{ data: BrowsingSession[] }> {
  const res = await fetch(`/api/v2/sessions/${id}/children`);
  return checkedJson(res, 'fetchSessionChildren');
}

export async function fetchLiveSessions(params: Record<string, string | number | boolean | undefined> = {}): Promise<{ data: LiveSession[]; total: number; cursor?: string }> {
  const res = await fetch(`/api/v2/live/sessions${qs(params)}`);
  return checkedJson(res, 'fetchLiveSessions');
}

export async function fetchLiveSettings(): Promise<LiveSettings> {
  const res = await fetch('/api/v2/live/settings');
  return checkedJson(res, 'fetchLiveSettings');
}

export async function fetchLiveSession(id: string): Promise<LiveSession> {
  const res = await fetch(`/api/v2/live/sessions/${id}`);
  return checkedJson(res, 'fetchLiveSession');
}

export async function fetchLiveTurns(sessionId: string): Promise<{ data: LiveTurn[] }> {
  const res = await fetch(`/api/v2/live/sessions/${sessionId}/turns`);
  return checkedJson(res, 'fetchLiveTurns');
}

export async function fetchLiveItems(sessionId: string, params: { cursor?: string; limit?: number; kinds?: string } = {}): Promise<{ data: LiveItem[]; total: number; cursor?: string }> {
  const res = await fetch(`/api/v2/live/sessions/${sessionId}/items${qs(params)}`);
  return checkedJson(res, 'fetchLiveItems');
}

export async function searchMessages(params: { q: string; project?: string; agent?: string; limit?: number; cursor?: string }): Promise<{ data: SearchResult[]; total: number; cursor?: string }> {
  const res = await fetch(`/api/v2/search${qs(params)}`);
  return checkedJson(res, 'searchMessages');
}

export async function fetchAnalyticsSummary(params: Record<string, string | undefined> = {}): Promise<AnalyticsSummary> {
  const res = await fetch(`/api/v2/analytics/summary${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsSummary');
}

export async function fetchAnalyticsActivity(params: Record<string, string | number | undefined> = {}): Promise<{ data: ActivityDataPoint[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/activity${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsActivity');
}

export async function fetchAnalyticsProjects(params: Record<string, string | number | undefined> = {}): Promise<{ data: ProjectBreakdown[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/projects${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsProjects');
}

export async function fetchAnalyticsTools(params: Record<string, string | number | undefined> = {}): Promise<{ data: ToolUsageStat[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/tools${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsTools');
}

export async function fetchAnalyticsHourOfWeek(params: Record<string, string | number | undefined> = {}): Promise<{ data: HourOfWeekDataPoint[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/hour-of-week${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsHourOfWeek');
}

export async function fetchAnalyticsTopSessions(params: Record<string, string | number | undefined> = {}): Promise<{ data: TopSessionStat[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/top-sessions${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsTopSessions');
}

export async function fetchAnalyticsVelocity(params: Record<string, string | number | undefined> = {}): Promise<VelocityMetrics> {
  const res = await fetch(`/api/v2/analytics/velocity${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsVelocity');
}

export async function fetchAnalyticsAgents(params: Record<string, string | number | undefined> = {}): Promise<{ data: AgentComparisonRow[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/agents${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsAgents');
}

export async function fetchUsageSummary(params: Record<string, string | number | undefined> = {}): Promise<UsageSummary> {
  const res = await fetch(`/api/v2/usage/summary${qs(params)}`);
  return checkedJson(res, 'fetchUsageSummary');
}

export async function fetchUsageDaily(params: Record<string, string | number | undefined> = {}): Promise<{ data: UsageDailyPoint[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/daily${qs(params)}`);
  return checkedJson(res, 'fetchUsageDaily');
}

export async function fetchUsageProjects(params: Record<string, string | number | undefined> = {}): Promise<{ data: UsageProjectBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/projects${qs(params)}`);
  return checkedJson(res, 'fetchUsageProjects');
}

export async function fetchUsageModels(params: Record<string, string | number | undefined> = {}): Promise<{ data: UsageModelBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/models${qs(params)}`);
  return checkedJson(res, 'fetchUsageModels');
}

export async function fetchUsageAgents(params: Record<string, string | number | undefined> = {}): Promise<{ data: UsageAgentBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/agents${qs(params)}`);
  return checkedJson(res, 'fetchUsageAgents');
}

export async function fetchUsageTopSessions(params: Record<string, string | number | undefined> = {}): Promise<{ data: UsageTopSessionRow[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/top-sessions${qs(params)}`);
  return checkedJson(res, 'fetchUsageTopSessions');
}

export async function fetchV2Projects(): Promise<{ data: string[] }> {
  const res = await fetch('/api/v2/projects');
  return checkedJson(res, 'fetchV2Projects');
}

export async function fetchV2Agents(): Promise<{ data: string[] }> {
  const res = await fetch('/api/v2/agents');
  return checkedJson(res, 'fetchV2Agents');
}
