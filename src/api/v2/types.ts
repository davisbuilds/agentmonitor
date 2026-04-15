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
