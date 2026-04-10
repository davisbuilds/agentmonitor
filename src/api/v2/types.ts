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
}

export interface ActivityDataPoint {
  date: string;
  sessions: number;
  messages: number;
}

export interface ProjectBreakdown {
  project: string;
  session_count: number;
  message_count: number;
}

export interface ToolUsageStat {
  tool_name: string;
  category: string | null;
  count: number;
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
}
