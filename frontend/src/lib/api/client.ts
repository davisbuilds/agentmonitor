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
  quota_monitor?: QuotaMonitorData[];
  usage_monitor?: QuotaMonitorData[];
}

export interface QuotaMonitorWindow {
  used_percent: number;
  remaining_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
}

export interface QuotaMonitorCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface QuotaMonitorData {
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
  primary: QuotaMonitorWindow | null;
  secondary: QuotaMonitorWindow | null;
  credits: QuotaMonitorCredits | null;
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

export interface PinnedMessage {
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
  session_project: string | null;
  session_agent: string;
  session_started_at: string | null;
  session_ended_at: string | null;
  session_first_message: string | null;
}

export type SearchSort = 'recent' | 'relevance';

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
  cache_hit_rate: number;
  estimated_cache_savings_usd: number;
  pricing_known_events: number;
  pricing_unknown_events: number;
  unknown_model_events: number;
  prior_total_cost_usd: number;
  cost_delta_pct: number;
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
  canonical_model: string;
  provider: string;
  family: string;
  tier: string;
  known: boolean;
  deprecated: boolean;
  pricing_status: 'known' | 'deprecated' | 'unknown';
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
  session_count: number;
}

export interface UsageTierBreakdown {
  provider: string;
  tier: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
  session_count: number;
  unknown_model_events: number;
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
  primary_model: string;
  primary_tier: string;
  primary_provider: string;
  model_count: number;
  tier_costs: Array<{
    provider: string;
    tier: string;
    cost_usd: number;
    usage_events: number;
  }>;
  unknown_model_events: number;
  browsing_session_available: boolean;
}

export type UsageTierFeedbackConfidence = 'low' | 'medium' | 'high';

export interface UsageTierFeedbackReport {
  generated_at: string;
  window: {
    date_from: string | null;
    date_to: string | null;
    project: string | null;
    agent: string | null;
    model: string | null;
    provider: string | null;
    tier: string | null;
  };
  tier_mismatches: Array<{
    kind: 'high_cost_low_tier' | 'low_complexity_premium_tier';
    recommendation: string;
    confidence: UsageTierFeedbackConfidence;
    evidence: {
      provider: string;
      tier: string;
      session_count: number;
      total_cost_usd: number;
      average_cost_usd: number;
      sample_sessions: string[];
    };
  }>;
  cost_outliers: Array<{
    kind: 'unknown_model_spend';
    recommendation: string;
    confidence: UsageTierFeedbackConfidence;
    evidence: {
      total_cost_usd: number;
      share_of_window_cost: number;
      usage_events: number;
      sample_models: string[];
    };
  }>;
  confidence: UsageTierFeedbackConfidence;
  evidence: {
    total_cost_usd: number;
    usage_events: number;
    session_count: number;
    method: string;
  };
  human_review_required: true;
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
  usage_tiers: UsageTierBreakdown[];
  usage_agents: UsageAgentBreakdown[];
  usage_top_sessions: UsageTopSessionRow[];
}

export interface Insight {
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

export interface InsightGenerationStatus {
  default_provider: InsightProvider;
  providers: Record<InsightProvider, {
    configured: boolean;
    default_model: string;
  }>;
}

export interface TraceQualityAggregateMetrics {
  observation_count: number;
  error_count: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_cost_usd: number;
  total_duration_ms: number;
  first_observation_at: string | null;
  last_observation_at: string | null;
}

export interface TraceQualityScoreCoverage {
  scored_traces: number;
  unscored_traces: number;
  total_scores: number;
  trace_score_count: number;
  observation_score_count: number;
  numeric_score_count: number;
}

export interface TraceQualityReadCoverage {
  matching_traces: number;
  included_traces: number;
  excluded_low_coverage_traces: number;
  observations_with_usage: number;
  observations_missing_usage: number;
  score_coverage: TraceQualityScoreCoverage;
  note: string;
}

export interface TraceQualityPromptRef {
  id: number;
  name: string;
  version: string | null;
  label: string | null;
  source: string;
  content_hash: string | null;
  file_path: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  observation_count: number;
  trace_count: number;
}

export interface TraceQualityScore {
  id: number;
  target_type: string;
  target_id: string;
  name: string;
  value_type: string;
  numeric_value: number | null;
  categorical_value: string | null;
  boolean_value: number | null;
  text_value: string | null;
  source: string;
  evaluator_name: string | null;
  comment: string | null;
  metadata: Record<string, unknown>;
  value: number | string | boolean | null;
  created_at: string;
}

export type TraceQualityScoreMutationValue = number | string | boolean;

export interface TraceQualityScoreMutationInput {
  target_type?: 'session' | 'trace' | 'observation' | 'message' | 'event' | 'session_item';
  target_id?: string;
  name?: string;
  value_type?: 'numeric' | 'categorical' | 'boolean' | 'text';
  value?: TraceQualityScoreMutationValue;
  numeric_value?: number;
  categorical_value?: string;
  boolean_value?: boolean | 0 | 1;
  text_value?: string;
  source?: 'human' | 'code_evaluator' | 'llm_judge' | 'api';
  evaluator_name?: string | null;
  comment?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TraceQualityScoreSummary {
  name: string;
  value_type: string;
  count: number;
  numeric_avg: number | null;
  numeric_min: number | null;
  numeric_max: number | null;
  boolean_true: number;
  boolean_false: number;
  categorical_values: Record<string, number>;
  scored_traces: number;
}

export type TraceQualityScoreRollupDimension = 'trace' | 'session' | 'model' | 'tool' | 'prompt' | 'day';

export interface TraceQualityScoreRollup {
  dimension: TraceQualityScoreRollupDimension;
  key: string;
  label: string | null;
  score_count: number;
  numeric_score_count: number;
  numeric_avg: number | null;
  boolean_true: number;
  boolean_false: number;
  categorical_values: Record<string, number>;
  trace_count: number;
  observation_count: number;
  first_score_at: string | null;
  last_score_at: string | null;
}

export type TraceQualityScoreRollups = Record<TraceQualityScoreRollupDimension, TraceQualityScoreRollup[]>;

export interface TraceQualityTrace {
  id: string;
  session_id: string;
  browsing_session_id: string | null;
  source_trace_id: string | null;
  agent_type: string;
  name: string;
  status: string | null;
  project: string | null;
  branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
  tags: unknown[];
  coverage: Record<string, unknown>;
  aggregate: TraceQualityAggregateMetrics;
  score_count: number;
  numeric_score_avg: number | null;
  created_at: string;
}

export interface TraceQualityTraceDetail extends TraceQualityTrace {
  prompt_refs: TraceQualityPromptRef[];
  score_summary: TraceQualityScoreSummary[];
}

export interface TraceQualityObservation {
  id: string;
  trace_id: string;
  parent_observation_id: string | null;
  session_id: string;
  source_kind: string;
  source_id: string | null;
  source_item_id: string | null;
  observation_type: string;
  name: string;
  status: string | null;
  status_message: string | null;
  severity: string | null;
  model: string | null;
  tool_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  input_hash: string | null;
  output_hash: string | null;
  input_summary: string | null;
  output_summary: string | null;
  payload_policy: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TraceQualityObservationTreeNode extends TraceQualityObservation {
  children: TraceQualityObservationTreeNode[];
}

export interface TraceQualityObservationDetail extends TraceQualityObservation {
  trace: Pick<TraceQualityTrace, 'id' | 'session_id' | 'agent_type' | 'name' | 'status' | 'project' | 'started_at'>;
  prompt_refs: TraceQualityPromptRef[];
  scores: TraceQualityScore[];
}

export interface TraceQualityPromptRollup extends TraceQualityPromptRef {
  generation_count: number;
  median_duration_ms: number | null;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  score_count: number;
  median_numeric_score: number | null;
  last_seen: string | null;
  latest_observation_at: string | null;
}

export interface TraceQualityFinding {
  id: string;
  kind: 'observation_error' | 'low_score' | 'low_coverage';
  severity: 'info' | 'warning' | 'error' | 'critical';
  trace_id: string;
  observation_id: string | null;
  score_id: number | null;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  created_at: string | null;
}

// --- API client ---

type Filters = Record<string, string>;

function monitorCostFiltersToUsageParams(filters: Filters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.project) params.project = filters.project;
  if (filters.agent_type) params.agent = filters.agent_type;
  if (filters.since) params.date_from = filters.since;
  return params;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
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
  const params: Record<string, string> = {};
  if (filters.agent_type) params.agent = filters.agent_type;
  if (filters.agent) params.agent = filters.agent;
  if (filters.since) params.since = filters.since;
  if (filters.date_from) params.since = filters.date_from;

  const res = await fetch(`/api/v2/monitor/stats${qs(params)}`);
  return checkedJson(res, 'fetchStats');
}

export async function fetchEvents(filters: Filters = {}, limit = 100): Promise<{ events: AgentEvent[]; total: number }> {
  const params: Record<string, string | number> = { limit };
  if (filters.offset) params.offset = filters.offset;
  if (filters.agent_type) params.agent = filters.agent_type;
  if (filters.agent) params.agent = filters.agent;
  if (filters.event_type) params.event_type = filters.event_type;
  if (filters.tool_name) params.tool_name = filters.tool_name;
  if (filters.session_id) params.session_id = filters.session_id;
  if (filters.branch) params.branch = filters.branch;
  if (filters.model) params.model = filters.model;
  if (filters.source) params.source = filters.source;
  if (filters.since) params.since = filters.since;
  if (filters.until) params.until = filters.until;

  const res = await fetch(`/api/v2/monitor/events${qs(params)}`);
  return checkedJson(res, 'fetchEvents');
}

export async function fetchMonitorSessions(filters: Filters = {}): Promise<{ sessions: Session[]; total: number }> {
  const params: Record<string, string> = {};
  if (filters.status) params.status = filters.status;
  if (filters.exclude_status) params.exclude_status = filters.exclude_status;
  if (filters.project) params.project = filters.project;
  if (filters.agent_type) params.agent = filters.agent_type;
  if (filters.agent) params.agent = filters.agent;
  if (filters.since) params.date_from = filters.since;
  if (filters.date_from) params.date_from = filters.date_from;
  if (filters.date_to) params.date_to = filters.date_to;
  if (filters.limit) params.limit = filters.limit;

  const res = await fetch(`/api/v2/monitor/sessions${qs(params)}`);
  return checkedJson(res, 'fetchMonitorSessions');
}

export async function fetchFilterOptions(): Promise<FilterOptions> {
  const res = await fetch('/api/v2/monitor/filter-options');
  return checkedJson(res, 'fetchFilterOptions');
}

export async function fetchCostData(filters: Filters = {}): Promise<CostData> {
  const params = monitorCostFiltersToUsageParams(filters);
  const [daily, projects, models] = await Promise.all([
    fetchUsageDaily(params),
    fetchUsageProjects(params),
    fetchUsageModels(params),
  ]);

  return {
    timeline: daily.data.map((item) => ({
      date: item.date,
      cost: item.cost_usd,
    })),
    by_project: projects.data.map((item) => ({
      project: item.project,
      cost: item.cost_usd,
      session_count: item.session_count,
      event_count: item.usage_events,
    })),
    by_model: models.data.map((item) => ({
      model: item.model,
      cost: item.cost_usd,
    })),
  };
}

export async function fetchToolStats(filters: Filters = {}): Promise<ToolStats> {
  const res = await fetch(`/api/v2/monitor/tools${qs(monitorCostFiltersToUsageParams(filters))}`);
  return checkedJson(res, 'fetchToolStats');
}

export async function fetchSessionDetail(id: string, eventLimit = 10): Promise<{ session: Session; events: AgentEvent[] }> {
  const res = await fetch(`/api/v2/monitor/sessions/${encodeURIComponent(id)}?event_limit=${eventLimit}`);
  return checkedJson(res, 'fetchSessionDetail');
}

export async function fetchTranscript(id: string): Promise<{ transcript: Array<{ role: string; content: string; timestamp?: string }> }> {
  const res = await fetch(`/api/v2/monitor/sessions/${encodeURIComponent(id)}/transcript`);
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

export async function fetchMessages(sessionId: string, params: { offset?: number; limit?: number; around_ordinal?: number } = {}): Promise<{ data: Message[]; total: number }> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/messages${qs(params)}`);
  return checkedJson(res, 'fetchMessages');
}

export async function fetchSessionActivity(sessionId: string): Promise<SessionActivity> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/activity`);
  return checkedJson(res, 'fetchSessionActivity');
}

export async function fetchSessionChildren(id: string): Promise<{ data: BrowsingSession[] }> {
  const res = await fetch(`/api/v2/sessions/${id}/children`);
  return checkedJson(res, 'fetchSessionChildren');
}

export async function fetchPins(params: { project?: string } = {}): Promise<{ data: PinnedMessage[] }> {
  const res = await fetch(`/api/v2/pins${qs(params)}`);
  return checkedJson(res, 'fetchPins');
}

export async function fetchSessionPins(sessionId: string): Promise<{ data: PinnedMessage[] }> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/pins`);
  return checkedJson(res, 'fetchSessionPins');
}

export async function pinSessionMessage(sessionId: string, messageId: number): Promise<PinnedMessage> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/messages/${messageId}/pin`, {
    method: 'POST',
  });
  return checkedJson(res, 'pinSessionMessage');
}

export async function unpinSessionMessage(sessionId: string, messageId: number): Promise<{ removed: boolean; message_ordinal: number | null }> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/messages/${messageId}/pin`, {
    method: 'DELETE',
  });
  return checkedJson(res, 'unpinSessionMessage');
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

export async function searchMessages(params: { q: string; project?: string; agent?: string; sort?: SearchSort; limit?: number; cursor?: string }): Promise<{ data: SearchResult[]; total: number; cursor?: string }> {
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

export async function fetchAnalyticsSkillsDaily(params: Record<string, string | number | undefined> = {}): Promise<{ data: SkillUsageDay[]; coverage: AnalyticsCoverage }> {
  const res = await fetch(`/api/v2/analytics/skills/daily${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsSkillsDaily');
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

export async function fetchUsageSummary(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<UsageSummary> {
  const res = await fetch(`/api/v2/usage/summary${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageSummary');
}

export async function fetchUsageDaily(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<{ data: UsageDailyPoint[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/daily${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageDaily');
}

export async function fetchUsageProjects(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<{ data: UsageProjectBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/projects${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageProjects');
}

export async function fetchUsageModels(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<{ data: UsageModelBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/models${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageModels');
}

export async function fetchUsageTiers(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<{ data: UsageTierBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/tiers${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageTiers');
}

export async function fetchUsageAgents(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<{ data: UsageAgentBreakdown[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/agents${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageAgents');
}

export async function fetchUsageTopSessions(params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<{ data: UsageTopSessionRow[]; coverage: UsageCoverage }> {
  const res = await fetch(`/api/v2/usage/top-sessions${qs(params)}`, init);
  return checkedJson(res, 'fetchUsageTopSessions');
}

export async function fetchUsageTierFeedback(params: Record<string, string | number | undefined> = {}): Promise<UsageTierFeedbackReport> {
  const res = await fetch(`/api/v2/usage/tier-feedback${qs(params)}`);
  return checkedJson(res, 'fetchUsageTierFeedback');
}

export async function fetchTraceQualityTraces(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: TraceQualityTrace[]; total: number; limit: number; offset: number; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/traces${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityTraces');
}

export async function fetchTraceQualityTrace(
  id: string,
): Promise<{ trace: TraceQualityTraceDetail; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/traces/${encodeURIComponent(id)}`);
  return checkedJson(res, 'fetchTraceQualityTrace');
}

export async function fetchTraceQualityObservations(
  traceId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{
  data: TraceQualityObservation[];
  tree: TraceQualityObservationTreeNode[];
  total: number;
  limit: number;
  offset: number;
  coverage: TraceQualityReadCoverage;
}> {
  const res = await fetch(`/api/v2/trace-quality/traces/${encodeURIComponent(traceId)}/observations${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityObservations');
}

export async function fetchTraceQualityObservation(
  id: string,
): Promise<{ observation: TraceQualityObservationDetail; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/observations/${encodeURIComponent(id)}`);
  return checkedJson(res, 'fetchTraceQualityObservation');
}

export async function fetchTraceQualityScores(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: TraceQualityScore[]; total: number; limit: number; offset: number; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/scores${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityScores');
}

export async function createTraceQualityScore(
  input: Required<Pick<TraceQualityScoreMutationInput, 'target_type' | 'target_id' | 'name' | 'value_type'>> & TraceQualityScoreMutationInput,
): Promise<{ score: TraceQualityScore }> {
  const res = await fetch('/api/v2/trace-quality/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return checkedJson(res, 'createTraceQualityScore');
}

export async function updateTraceQualityScore(
  id: number,
  input: TraceQualityScoreMutationInput,
): Promise<{ score: TraceQualityScore }> {
  const res = await fetch(`/api/v2/trace-quality/scores/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return checkedJson(res, 'updateTraceQualityScore');
}

export async function deleteTraceQualityScore(id: number): Promise<{ deleted: true }> {
  const res = await fetch(`/api/v2/trace-quality/scores/${id}`, {
    method: 'DELETE',
  });
  return checkedJson(res, 'deleteTraceQualityScore');
}

export async function fetchTraceQualityScoreSummary(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: TraceQualityScoreSummary[]; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/score-summary${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityScoreSummary');
}

export async function fetchTraceQualityScoreRollups(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: TraceQualityScoreRollups; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/score-rollups${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityScoreRollups');
}

export async function fetchTraceQualityPrompts(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: TraceQualityPromptRollup[]; total: number; limit: number; offset: number; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/prompts${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityPrompts');
}

export async function fetchTraceQualityFindings(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<{ data: TraceQualityFinding[]; total: number; limit: number; offset: number; coverage: TraceQualityReadCoverage }> {
  const res = await fetch(`/api/v2/trace-quality/findings${qs(params)}`);
  return checkedJson(res, 'fetchTraceQualityFindings');
}

export async function fetchInsights(params: Record<string, string | number | undefined> = {}): Promise<{ data: Insight[]; generation: InsightGenerationStatus }> {
  const res = await fetch(`/api/v2/insights${qs(params)}`);
  return checkedJson(res, 'fetchInsights');
}

export async function fetchInsight(id: number): Promise<Insight> {
  const res = await fetch(`/api/v2/insights/${id}`);
  return checkedJson(res, 'fetchInsight');
}

export async function generateInsight(params: {
  kind: InsightKind;
  date_from: string;
  date_to: string;
  project?: string;
  agent?: string;
  prompt?: string;
  provider?: InsightProvider;
  model?: string;
}): Promise<Insight> {
  const res = await fetch('/api/v2/insights/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  return checkedJson(res, 'generateInsight');
}

export async function deleteInsight(id: number): Promise<{ removed: boolean }> {
  const res = await fetch(`/api/v2/insights/${id}`, {
    method: 'DELETE',
  });
  return checkedJson(res, 'deleteInsight');
}

export async function fetchV2Projects(): Promise<{ data: string[] }> {
  const res = await fetch('/api/v2/projects');
  return checkedJson(res, 'fetchV2Projects');
}

export async function fetchV2Agents(): Promise<{ data: string[] }> {
  const res = await fetch('/api/v2/agents');
  return checkedJson(res, 'fetchV2Agents');
}
