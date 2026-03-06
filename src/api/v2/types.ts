// --- Content Blocks (stored as JSON array in messages.content) ---

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface CodeBlock {
  type: 'code';
  code: string;
  language?: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  tool_use_id: string;
  tool_name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | CodeBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// --- Database row types ---

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
  file_path: string | null;
  file_size: number | null;
  file_hash: string | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content: string; // JSON-serialized ContentBlock[]
  timestamp: string | null;
  has_thinking: number;
  has_tool_use: number;
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

export interface WatchedFileRow {
  file_path: string;
  file_hash: string;
  file_mtime: string | null;
  status: string;
  last_parsed_at: string;
}

// --- API response types ---

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
}

export interface Message {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content: ContentBlock[];
  timestamp: string | null;
  has_thinking: boolean;
  has_tool_use: boolean;
  content_length: number;
}

export interface ToolCall {
  id: number;
  message_id: number;
  session_id: string;
  tool_name: string;
  category: string | null;
  tool_use_id: string | null;
  input: unknown;
  result_content: string | null;
  subagent_session_id: string | null;
}

export interface SearchResult {
  session_id: string;
  session: BrowsingSession;
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

// --- API request/response envelopes ---

export interface PaginatedResponse<T> {
  data: T[];
  cursor?: string;
  total?: number;
}

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
