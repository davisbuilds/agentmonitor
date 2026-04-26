import type { ProjectionCapabilities } from '../../live/projector.js';

// --- Database row types (also used as API response shapes) ---

export interface BrowsingSessionRow {
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
  live_status: string | null;
  last_item_at: string | null;
  integration_mode: string | null;
  fidelity: string | null;
  capabilities: ProjectionCapabilities | null;
  file_path: string | null;
  file_size: number | null;
  file_hash: string | null;
}

export interface BrowsingSessionDbRow extends Omit<BrowsingSessionRow, 'capabilities'> {
  capabilities_json: string | null;
}

export type LiveSessionRow = BrowsingSessionRow;

export interface LiveTurnRow {
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

export interface LiveItemRow {
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

export interface LivePlanStep {
  id?: string;
  label: string;
  status?: string;
}

export interface LivePlanState {
  summary?: string;
  steps: LivePlanStep[];
}

export interface MessageRow {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content: string; // JSON-serialized content blocks
  timestamp: string | null;
  has_thinking: number; // 0 or 1
  has_tool_use: number; // 0 or 1
  content_length: number;
}

export interface ToolCallRow {
  id: number;
  message_id: number;
  session_id: string;
  tool_name: string;
  category: string | null;
  tool_use_id: string | null;
  input_json: string | null;
  result_content: string | null;
  result_content_length: number | null;
  subagent_session_id: string | null;
}

export interface SessionActivityBucket {
  bucket_index: number;
  start_ordinal: number | null;
  end_ordinal: number | null;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
}

export interface SessionActivity {
  bucket_count: number;
  total_messages: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
  timestamped_messages: number;
  untimestamped_messages: number;
  navigation_basis: 'timestamp' | 'ordinal' | 'mixed';
  data: SessionActivityBucket[];
}

export interface PinnedMessageRow {
  id: number;
  session_id: string;
  message_id: number | null;
  message_ordinal: number;
  role: string | null;
  content: string | null;
  message_timestamp: string | null;
  created_at: string;
  session_project: string | null;
  session_agent: string | null;
  session_first_message: string | null;
}

// --- Aggregate query result ---

export interface CountResult {
  c: number;
}

// --- Analytics response types ---

export interface AnalyticsSummary {
  total_sessions: number;
  total_messages: number;
  total_user_messages: number;
  daily_average_sessions: number;
  daily_average_messages: number;
  date_range: {
    earliest: string | null;
    latest: string | null;
  };
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

export interface MonitorToolStat {
  tool_name: string;
  total_calls: number;
  error_count: number;
  error_rate: number;
  avg_duration_ms: number | null;
  by_agent: Record<string, number>;
}

export interface MonitorSessionRow {
  id: string;
  agent_id: string;
  agent_type: string;
  project: string | null;
  branch: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  metadata: string | null;
  event_count: number;
  tokens_in: number;
  tokens_out: number;
  total_cost_usd: number;
  files_edited: number;
  lines_added: number;
  lines_removed: number;
}

export interface MonitorEventRow {
  id: number;
  event_id: string | null;
  schema_version: number;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  branch: string | null;
  project: string | null;
  duration_ms: number | null;
  created_at: string;
  client_timestamp: string | null;
  metadata: string | null;
  payload_truncated: number;
  model: string | null;
  cost_usd: number | null;
  cache_read_tokens: number;
  cache_write_tokens: number;
  source: string;
}

export interface MonitorQuotaWindow {
  used_percent: number;
  remaining_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
}

export interface MonitorQuotaCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface MonitorQuotaSnapshot {
  provider: 'claude' | 'codex';
  agent_type: 'claude_code' | 'codex';
  status: 'available' | 'unavailable' | 'error';
  source: string | null;
  updated_at: string | null;
  account_label: string | null;
  plan_type: string | null;
  limit_id: string | null;
  limit_name: string | null;
  error_message: string | null;
  primary: MonitorQuotaWindow | null;
  secondary: MonitorQuotaWindow | null;
  credits: MonitorQuotaCredits | null;
}

export interface MonitorStats {
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
  quota_monitor: MonitorQuotaSnapshot[];
  usage_monitor: MonitorQuotaSnapshot[];
}

export interface MonitorFilterOptions {
  agent_types: string[];
  event_types: string[];
  tool_names: string[];
  models: string[];
  projects: string[];
  branches: Array<{ value: string; label: string }>;
  sources: string[];
}

export interface SkillUsageBreakdown {
  skill_name: string;
  count: number;
}

export interface SkillUsageDay {
  date: string;
  total: number;
  skills: SkillUsageBreakdown[];
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

export type InsightKind = 'overview' | 'workflow' | 'usage';
export type InsightProvider = 'openai' | 'anthropic' | 'gemini';

export interface InsightInputSnapshot {
  analytics_activity: ActivityDataPoint[];
  analytics_projects: ProjectBreakdown[];
  analytics_tools: ToolUsageStat[];
  analytics_hour_of_week: HourOfWeekDataPoint[];
  analytics_top_sessions: TopSessionStat[];
  analytics_velocity: VelocityMetrics;
  analytics_agents: AgentComparisonRow[];
  usage_daily: UsageDailyPoint[];
  usage_projects: UsageProjectBreakdown[];
  usage_models: UsageModelBreakdown[];
  usage_agents: UsageAgentBreakdown[];
  usage_top_sessions: UsageTopSessionRow[];
}

export interface InsightRow {
  id: number;
  kind: InsightKind;
  title: string;
  prompt: string | null;
  content: string;
  date_from: string;
  date_to: string;
  project: string | null;
  agent: string | null;
  provider: string;
  model: string;
  analytics_summary: AnalyticsSummary;
  analytics_coverage: AnalyticsCoverage;
  usage_summary: UsageSummary;
  usage_coverage: UsageCoverage;
  input_snapshot: InsightInputSnapshot;
  created_at: string;
}

export interface InsightDbRow extends Omit<
  InsightRow,
  'analytics_summary' | 'analytics_coverage' | 'usage_summary' | 'usage_coverage' | 'input_snapshot'
> {
  analytics_summary_json: string;
  analytics_coverage_json: string;
  usage_summary_json: string;
  usage_coverage_json: string;
  input_json: string;
}

export interface SearchResultRow {
  session_id: string;
  message_id: number;
  message_ordinal: number;
  message_role: string;
  snippet: string;
  session_project: string | null;
  session_agent: string;
  session_started_at: string | null;
  session_ended_at: string | null;
  session_first_message: string | null;
}

// --- API request params ---

export interface SessionsListParams {
  limit?: number;
  cursor?: string;
  project?: string;
  agent?: string;
  date_from?: string;
  date_to?: string;
  min_messages?: number;
  max_messages?: number;
}

export interface MessagesListParams {
  offset?: number;
  limit?: number;
  around_ordinal?: number;
}

export interface LiveSessionsListParams {
  limit?: number;
  cursor?: string;
  project?: string;
  agent?: string;
  live_status?: string;
  fidelity?: string;
  active_only?: boolean;
}

export interface LiveItemsListParams {
  cursor?: string;
  limit?: number;
  kinds?: string[];
}

export interface SearchParams {
  q: string;
  project?: string;
  agent?: string;
  sort?: 'recent' | 'relevance';
  limit?: number;
  cursor?: string;
}

export interface AnalyticsParams {
  date_from?: string;
  date_to?: string;
  project?: string;
  agent?: string;
  limit?: number;
}

export interface UsageParams {
  date_from?: string;
  date_to?: string;
  project?: string;
  agent?: string;
  limit?: number;
}

export interface MonitorSessionsParams {
  status?: string;
  exclude_status?: string;
  project?: string;
  agent?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface MonitorEventsParams {
  limit?: number;
  offset?: number;
  agent?: string;
  event_type?: string;
  tool_name?: string;
  session_id?: string;
  branch?: string;
  model?: string;
  source?: string;
  since?: string;
  until?: string;
}

export interface MonitorStatsParams {
  agent?: string;
  since?: string;
}

export interface PinsListParams {
  project?: string;
}

export interface InsightsListParams {
  date_from?: string;
  date_to?: string;
  project?: string;
  agent?: string;
  kind?: InsightKind;
  limit?: number;
}

export interface GenerateInsightParams {
  date_from: string;
  date_to: string;
  kind: InsightKind;
  project?: string;
  agent?: string;
  prompt?: string;
  provider?: InsightProvider;
  model?: string;
}
