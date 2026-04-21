use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectionCapabilities {
    pub history: String,
    pub search: String,
    pub tool_analytics: String,
    pub live_items: String,
}

#[derive(Debug, Clone)]
struct BrowsingSessionDbRow {
    id: String,
    project: Option<String>,
    agent: String,
    first_message: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    message_count: i64,
    user_message_count: i64,
    parent_session_id: Option<String>,
    relationship_type: Option<String>,
    live_status: Option<String>,
    last_item_at: Option<String>,
    integration_mode: Option<String>,
    fidelity: Option<String>,
    capabilities_json: Option<String>,
    file_path: Option<String>,
    file_size: Option<i64>,
    file_hash: Option<String>,
}

impl BrowsingSessionDbRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project: row.get("project")?,
            agent: row.get("agent")?,
            first_message: row.get("first_message")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
            parent_session_id: row.get("parent_session_id")?,
            relationship_type: row.get("relationship_type")?,
            live_status: row.get("live_status")?,
            last_item_at: row.get("last_item_at")?,
            integration_mode: row.get("integration_mode")?,
            fidelity: row.get("fidelity")?,
            capabilities_json: row.get("capabilities_json")?,
            file_path: row.get("file_path")?,
            file_size: row.get("file_size")?,
            file_hash: row.get("file_hash")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowsingSessionRow {
    pub id: String,
    pub project: Option<String>,
    pub agent: String,
    pub first_message: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub message_count: i64,
    pub user_message_count: i64,
    pub parent_session_id: Option<String>,
    pub relationship_type: Option<String>,
    pub live_status: Option<String>,
    pub last_item_at: Option<String>,
    pub integration_mode: Option<String>,
    pub fidelity: Option<String>,
    pub capabilities: Option<ProjectionCapabilities>,
    pub file_path: Option<String>,
    pub file_size: Option<i64>,
    pub file_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageRow {
    pub id: i64,
    pub session_id: String,
    pub ordinal: i64,
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
    pub has_thinking: i64,
    pub has_tool_use: i64,
    pub content_length: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionActivityBucket {
    pub bucket_index: i64,
    pub start_ordinal: Option<i64>,
    pub end_ordinal: Option<i64>,
    pub message_count: i64,
    pub user_message_count: i64,
    pub assistant_message_count: i64,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionActivity {
    pub bucket_count: i64,
    pub total_messages: i64,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub timestamped_messages: i64,
    pub untimestamped_messages: i64,
    pub navigation_basis: String,
    pub data: Vec<SessionActivityBucket>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PinnedMessageRow {
    pub id: i64,
    pub session_id: String,
    pub message_id: Option<i64>,
    pub message_ordinal: i64,
    pub role: Option<String>,
    pub content: Option<String>,
    pub message_timestamp: Option<String>,
    pub created_at: String,
    pub session_project: Option<String>,
    pub session_agent: Option<String>,
    pub session_first_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveTurnRow {
    pub id: i64,
    pub session_id: String,
    pub agent_type: String,
    pub source_turn_id: Option<String>,
    pub status: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub created_at: String,
}

impl LiveTurnRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            agent_type: row.get("agent_type")?,
            source_turn_id: row.get("source_turn_id")?,
            status: row.get("status")?,
            title: row.get("title")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveItemRow {
    pub id: i64,
    pub session_id: String,
    pub turn_id: Option<i64>,
    pub ordinal: i64,
    pub source_item_id: Option<String>,
    pub kind: String,
    pub status: Option<String>,
    pub payload_json: String,
    pub created_at: Option<String>,
}

impl LiveItemRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            turn_id: row.get("turn_id")?,
            ordinal: row.get("ordinal")?,
            source_item_id: row.get("source_item_id")?,
            kind: row.get("kind")?,
            status: row.get("status")?,
            payload_json: row.get("payload_json")?,
            created_at: row.get("created_at")?,
        })
    }
}

impl MessageRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            ordinal: row.get("ordinal")?,
            role: row.get("role")?,
            content: row.get("content")?,
            timestamp: row.get("timestamp")?,
            has_thinking: row.get("has_thinking")?,
            has_tool_use: row.get("has_tool_use")?,
            content_length: row.get("content_length")?,
        })
    }
}

impl SessionActivityBucket {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            bucket_index: row.get("bucket_index")?,
            start_ordinal: row.get("start_ordinal")?,
            end_ordinal: row.get("end_ordinal")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
            assistant_message_count: row.get("assistant_message_count")?,
            first_timestamp: row.get("first_timestamp")?,
            last_timestamp: row.get("last_timestamp")?,
        })
    }
}

impl PinnedMessageRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            message_id: row.get("message_id")?,
            message_ordinal: row.get("message_ordinal")?,
            role: row.get("role")?,
            content: row.get("content")?,
            message_timestamp: row.get("message_timestamp")?,
            created_at: row.get("created_at")?,
            session_project: row.get("session_project")?,
            session_agent: row.get("session_agent")?,
            session_first_message: row.get("session_first_message")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResultRow {
    pub session_id: String,
    pub message_id: i64,
    pub message_ordinal: i64,
    pub message_role: String,
    pub snippet: String,
    pub session_project: Option<String>,
    pub session_agent: String,
    pub session_started_at: Option<String>,
    pub session_ended_at: Option<String>,
    pub session_first_message: Option<String>,
}

impl SearchResultRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            session_id: row.get("session_id")?,
            message_id: row.get("message_id")?,
            message_ordinal: row.get("message_ordinal")?,
            message_role: row.get("message_role")?,
            snippet: row.get("snippet")?,
            session_project: row.get("session_project")?,
            session_agent: row.get("session_agent")?,
            session_started_at: row.get("session_started_at")?,
            session_ended_at: row.get("session_ended_at")?,
            session_first_message: row.get("session_first_message")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsSummary {
    pub total_sessions: i64,
    pub total_messages: i64,
    pub total_user_messages: i64,
    pub daily_average_sessions: f64,
    pub daily_average_messages: f64,
    pub date_range: AnalyticsDateRange,
    pub coverage: AnalyticsCoverage,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsDateRange {
    pub earliest: Option<String>,
    pub latest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityDataPoint {
    pub date: String,
    pub sessions: i64,
    pub messages: i64,
    pub user_messages: i64,
}

impl ActivityDataPoint {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            date: row.get("date")?,
            sessions: row.get("sessions")?,
            messages: row.get("messages")?,
            user_messages: row.get("user_messages")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectBreakdown {
    pub project: String,
    pub session_count: i64,
    pub message_count: i64,
    pub user_message_count: i64,
}

impl ProjectBreakdown {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project: row.get("project")?,
            session_count: row.get("session_count")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolUsageStat {
    pub tool_name: String,
    pub category: Option<String>,
    pub count: i64,
}

impl ToolUsageStat {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            tool_name: row.get("tool_name")?,
            category: row.get("category")?,
            count: row.get("count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsCapabilityBreakdown {
    pub full: i64,
    pub summary: i64,
    pub none: i64,
    pub unknown: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsCoverageCapabilityBreakdown {
    pub history: AnalyticsCapabilityBreakdown,
    pub search: AnalyticsCapabilityBreakdown,
    pub tool_analytics: AnalyticsCapabilityBreakdown,
    pub live_items: AnalyticsCapabilityBreakdown,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsFidelityBreakdown {
    pub full: i64,
    pub summary: i64,
    pub unknown: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsCoverage {
    pub metric_scope: String,
    pub matching_sessions: i64,
    pub included_sessions: i64,
    pub excluded_sessions: i64,
    pub fidelity_breakdown: AnalyticsFidelityBreakdown,
    pub capability_breakdown: AnalyticsCoverageCapabilityBreakdown,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HourOfWeekDataPoint {
    pub day_of_week: i64,
    pub hour_of_day: i64,
    pub session_count: i64,
    pub message_count: i64,
    pub user_message_count: i64,
}

impl HourOfWeekDataPoint {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            day_of_week: row.get("day_of_week")?,
            hour_of_day: row.get("hour_of_day")?,
            session_count: row.get("session_count")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TopSessionStat {
    pub id: String,
    pub project: Option<String>,
    pub agent: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub message_count: i64,
    pub user_message_count: i64,
    pub tool_call_count: i64,
    pub fidelity: Option<String>,
}

impl TopSessionStat {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project: row.get("project")?,
            agent: row.get("agent")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
            tool_call_count: row.get("tool_call_count")?,
            fidelity: row.get("fidelity")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VelocityMetrics {
    pub total_sessions: i64,
    pub total_messages: i64,
    pub total_user_messages: i64,
    pub active_days: i64,
    pub span_days: i64,
    pub sessions_per_active_day: f64,
    pub messages_per_active_day: f64,
    pub sessions_per_calendar_day: f64,
    pub messages_per_calendar_day: f64,
    pub average_messages_per_session: f64,
    pub average_user_messages_per_session: f64,
    pub coverage: AnalyticsCoverage,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentComparisonRow {
    pub agent: String,
    pub session_count: i64,
    pub message_count: i64,
    pub user_message_count: i64,
    pub average_messages_per_session: f64,
    pub full_fidelity_sessions: i64,
    pub summary_fidelity_sessions: i64,
    pub tool_analytics_capable_sessions: i64,
    pub first_started_at: Option<String>,
    pub last_started_at: Option<String>,
}

impl AgentComparisonRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            agent: row.get("agent")?,
            session_count: row.get("session_count")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
            average_messages_per_session: row.get("average_messages_per_session")?,
            full_fidelity_sessions: row.get("full_fidelity_sessions")?,
            summary_fidelity_sessions: row.get("summary_fidelity_sessions")?,
            tool_analytics_capable_sessions: row.get("tool_analytics_capable_sessions")?,
            first_started_at: row.get("first_started_at")?,
            last_started_at: row.get("last_started_at")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageSourceBreakdown {
    pub source: String,
    pub event_count: i64,
    pub usage_event_count: i64,
    pub session_count: i64,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

impl UsageSourceBreakdown {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            source: row.get("source")?,
            event_count: row.get("event_count")?,
            usage_event_count: row.get("usage_event_count")?,
            session_count: row.get("session_count")?,
            cost_usd: row.get("cost_usd")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageCoverage {
    pub metric_scope: String,
    pub matching_events: i64,
    pub usage_events: i64,
    pub missing_usage_events: i64,
    pub matching_sessions: i64,
    pub usage_sessions: i64,
    pub sources_with_usage: i64,
    pub source_breakdown: Vec<UsageSourceBreakdown>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageSummary {
    pub total_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_write_tokens: i64,
    pub total_usage_events: i64,
    pub total_sessions: i64,
    pub active_days: i64,
    pub span_days: i64,
    pub average_cost_per_active_day: f64,
    pub average_cost_per_session: f64,
    pub peak_day: UsagePeakDay,
    pub coverage: UsageCoverage,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsagePeakDay {
    pub date: Option<String>,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageDailyPoint {
    pub date: String,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub usage_events: i64,
    pub session_count: i64,
}

impl UsageDailyPoint {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            date: row.get("date")?,
            cost_usd: row.get("cost_usd")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
            usage_events: row.get("usage_events")?,
            session_count: row.get("session_count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageProjectBreakdown {
    pub project: String,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub usage_events: i64,
    pub session_count: i64,
}

impl UsageProjectBreakdown {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project: row.get("project")?,
            cost_usd: row.get("cost_usd")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
            usage_events: row.get("usage_events")?,
            session_count: row.get("session_count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageModelBreakdown {
    pub model: String,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub usage_events: i64,
    pub session_count: i64,
}

impl UsageModelBreakdown {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            model: row.get("model")?,
            cost_usd: row.get("cost_usd")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
            usage_events: row.get("usage_events")?,
            session_count: row.get("session_count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageAgentBreakdown {
    pub agent: String,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub usage_events: i64,
    pub session_count: i64,
}

impl UsageAgentBreakdown {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            agent: row.get("agent")?,
            cost_usd: row.get("cost_usd")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
            usage_events: row.get("usage_events")?,
            session_count: row.get("session_count")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageTopSessionRow {
    pub id: String,
    pub project: Option<String>,
    pub agent: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub message_count: Option<i64>,
    pub user_message_count: Option<i64>,
    pub fidelity: Option<String>,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub event_count: i64,
    pub usage_events: i64,
    pub browsing_session_available: bool,
}

impl UsageTopSessionRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project: row.get("project")?,
            agent: row.get("agent")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            last_activity_at: row.get("last_activity_at")?,
            message_count: row.get("message_count")?,
            user_message_count: row.get("user_message_count")?,
            fidelity: row.get("fidelity")?,
            cost_usd: row.get("cost_usd")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
            event_count: row.get("event_count")?,
            usage_events: row.get("usage_events")?,
            browsing_session_available: row.get::<_, i64>("browsing_session_available")? == 1,
        })
    }
}

#[derive(Debug, Default, Clone)]
pub struct SessionsListParams {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub min_messages: Option<i64>,
    pub max_messages: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct MessagesListParams {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct LiveSessionsListParams {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub live_status: Option<String>,
    pub fidelity: Option<String>,
    pub active_only: bool,
}

#[derive(Debug, Default, Clone)]
pub struct LiveItemsListParams {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub kinds: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct SearchParams {
    pub q: String,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct AnalyticsParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct PinsListParams {
    pub project: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionsResult {
    pub data: Vec<BrowsingSessionRow>,
    pub total: i64,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessagesResult {
    pub data: Vec<MessageRow>,
    pub total: i64,
}

pub type LiveSessionsResult = SessionsResult;

#[derive(Debug, Clone, Serialize)]
pub struct LiveItemsResult {
    pub data: Vec<LiveItemRow>,
    pub total: i64,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResultPage {
    pub data: Vec<SearchResultRow>,
    pub total: i64,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TimeCursor {
    sort_at: String,
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelevanceCursor {
    rank: f64,
    message_id: i64,
}

pub fn list_browsing_sessions(
    conn: &Connection,
    params: &SessionsListParams,
) -> rusqlite::Result<SessionsResult> {
    let limit = params.limit.unwrap_or(200).clamp(1, 500);
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(project) = params.project.as_deref() {
        conditions.push("project = ?".into());
        values.push(SqlValue::Text(project.to_string()));
    }
    if let Some(agent) = params.agent.as_deref() {
        conditions.push("agent = ?".into());
        values.push(SqlValue::Text(agent.to_string()));
    }
    if let Some(date_from) = params.date_from.as_deref() {
        conditions.push("started_at >= ?".into());
        values.push(SqlValue::Text(date_from.to_string()));
    }
    if let Some(date_to) = params.date_to.as_deref() {
        conditions.push("started_at < date(?, '+1 day')".into());
        values.push(SqlValue::Text(date_to.to_string()));
    }
    if let Some(min_messages) = params.min_messages {
        conditions.push("message_count >= ?".into());
        values.push(SqlValue::Integer(min_messages));
    }
    if let Some(max_messages) = params.max_messages {
        conditions.push("message_count <= ?".into());
        values.push(SqlValue::Integer(max_messages));
    }

    let filter_where = where_clause(&conditions);
    let filter_refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let total_sql = format!("SELECT COUNT(*) FROM browsing_sessions {filter_where}");
    let total: i64 = conn.query_row(&total_sql, filter_refs.as_slice(), |row| row.get(0))?;

    if let Some(cursor) = decode_time_cursor(params.cursor.as_deref()) {
        conditions.push("(started_at < ? OR (started_at = ? AND id < ?))".into());
        values.push(SqlValue::Text(cursor.sort_at.clone()));
        values.push(SqlValue::Text(cursor.sort_at));
        values.push(SqlValue::Text(cursor.id));
    }

    let sql = format!(
        "SELECT * FROM browsing_sessions {} ORDER BY started_at DESC, id DESC LIMIT ?",
        where_clause(&conditions)
    );
    values.push(SqlValue::Integer(limit));
    let data = query_browsing_sessions(conn, &sql, &values)?;

    let cursor = data
        .last()
        .and_then(|last| {
            last.started_at.as_ref().map(|started_at| {
                encode_time_cursor(TimeCursor {
                    sort_at: started_at.clone(),
                    id: last.id.clone(),
                })
            })
        })
        .filter(|_| data.len() as i64 == limit);

    Ok(SessionsResult {
        data,
        total,
        cursor,
    })
}

pub fn get_browsing_session(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<BrowsingSessionRow>> {
    let mut stmt = conn.prepare("SELECT * FROM browsing_sessions WHERE id = ?1")?;
    let mut rows = stmt.query([id])?;
    match rows.next()? {
        Some(row) => Ok(Some(map_browsing_session(BrowsingSessionDbRow::from_row(
            row,
        )?))),
        None => Ok(None),
    }
}

pub fn get_session_children(
    conn: &Connection,
    parent_id: &str,
) -> rusqlite::Result<Vec<BrowsingSessionRow>> {
    query_browsing_sessions(
        conn,
        "SELECT * FROM browsing_sessions WHERE parent_session_id = ? ORDER BY started_at",
        &[SqlValue::Text(parent_id.to_string())],
    )
}

pub fn get_session_messages(
    conn: &Connection,
    session_id: &str,
    params: &MessagesListParams,
) -> rusqlite::Result<MessagesResult> {
    let offset = params.offset.unwrap_or(0).max(0);
    let limit = params.limit.unwrap_or(100).clamp(1, 1000);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT * FROM messages WHERE session_id = ?1 ORDER BY ordinal LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map((session_id, limit, offset), MessageRow::from_row)?;
    let data = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(MessagesResult { data, total })
}

pub fn get_session_activity(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<SessionActivity> {
    let summary = conn.query_row(
        "SELECT
            COUNT(*) as total_messages,
            COUNT(timestamp) as timestamped_messages,
            MIN(timestamp) as first_timestamp,
            MAX(timestamp) as last_timestamp
         FROM messages
         WHERE session_id = ?1",
        [session_id],
        |row| {
            Ok((
                row.get::<_, i64>("total_messages")?,
                row.get::<_, i64>("timestamped_messages")?,
                row.get::<_, Option<String>>("first_timestamp")?,
                row.get::<_, Option<String>>("last_timestamp")?,
            ))
        },
    )?;

    if summary.0 == 0 {
        return Ok(SessionActivity {
            bucket_count: 0,
            total_messages: 0,
            first_timestamp: None,
            last_timestamp: None,
            timestamped_messages: 0,
            untimestamped_messages: 0,
            navigation_basis: "ordinal".to_string(),
            data: Vec::new(),
        });
    }

    let bucket_count = summary.0.clamp(8, 40);
    let mut stmt = conn.prepare(
        "WITH ordered AS (
            SELECT
                ordinal,
                role,
                timestamp,
                ROW_NUMBER() OVER (ORDER BY ordinal) - 1 as seq,
                COUNT(*) OVER () as total_count
            FROM messages
            WHERE session_id = ?1
        ),
        bucketed AS (
            SELECT
                MIN(CAST((seq * ?2) / total_count AS INTEGER), ?3 - 1) as bucket_index,
                ordinal,
                role,
                timestamp
            FROM ordered
        )
        SELECT
            bucket_index,
            MIN(ordinal) as start_ordinal,
            MAX(ordinal) as end_ordinal,
            COUNT(*) as message_count,
            COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) as user_message_count,
            COALESCE(SUM(CASE WHEN role != 'user' THEN 1 ELSE 0 END), 0) as assistant_message_count,
            MIN(timestamp) as first_timestamp,
            MAX(timestamp) as last_timestamp
        FROM bucketed
        GROUP BY bucket_index
        ORDER BY bucket_index",
    )?;
    let rows = stmt.query_map(
        (session_id, bucket_count, bucket_count),
        SessionActivityBucket::from_row,
    )?;
    let buckets = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let by_index: HashMap<i64, SessionActivityBucket> = buckets
        .into_iter()
        .map(|bucket| (bucket.bucket_index, bucket))
        .collect();

    let mut data = Vec::new();
    for bucket_index in 0..bucket_count {
        data.push(
            by_index
                .get(&bucket_index)
                .cloned()
                .unwrap_or(SessionActivityBucket {
                    bucket_index,
                    start_ordinal: None,
                    end_ordinal: None,
                    message_count: 0,
                    user_message_count: 0,
                    assistant_message_count: 0,
                    first_timestamp: None,
                    last_timestamp: None,
                }),
        );
    }

    let untimestamped_messages = (summary.0 - summary.1).max(0);
    let navigation_basis = if summary.1 == 0 {
        "ordinal"
    } else if untimestamped_messages == 0 {
        "timestamp"
    } else {
        "mixed"
    };

    Ok(SessionActivity {
        bucket_count,
        total_messages: summary.0,
        first_timestamp: summary.2,
        last_timestamp: summary.3,
        timestamped_messages: summary.1,
        untimestamped_messages,
        navigation_basis: navigation_basis.to_string(),
        data,
    })
}

pub fn list_pinned_messages(
    conn: &Connection,
    params: &PinsListParams,
) -> rusqlite::Result<Vec<PinnedMessageRow>> {
    let mut conditions = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(session_id) = params.session_id.as_deref() {
        conditions.push("p.session_id = ?".to_string());
        values.push(SqlValue::Text(session_id.to_string()));
    } else if let Some(project) = params.project.as_deref() {
        conditions.push("bs.project = ?".to_string());
        values.push(SqlValue::Text(project.to_string()));
    }

    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT
            p.id,
            p.session_id,
            COALESCE(m.id, p.message_id) as message_id,
            p.message_ordinal,
            m.role,
            m.content,
            m.timestamp as message_timestamp,
            p.created_at,
            bs.project as session_project,
            bs.agent as session_agent,
            bs.first_message as session_first_message
         FROM pinned_messages p
         LEFT JOIN messages m
           ON m.session_id = p.session_id
          AND m.ordinal = p.message_ordinal
         LEFT JOIN browsing_sessions bs
           ON bs.id = p.session_id
         {where_sql}
         ORDER BY p.created_at DESC, p.id DESC"
    );
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), PinnedMessageRow::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

fn get_pin_message_lookup(
    conn: &Connection,
    session_id: &str,
    message_id: i64,
) -> rusqlite::Result<Option<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, ordinal
         FROM messages
         WHERE session_id = ?1 AND id = ?2",
    )?;
    let mut rows = stmt.query((session_id, message_id))?;
    match rows.next()? {
        Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
        None => Ok(None),
    }
}

pub fn pin_message(
    conn: &Connection,
    session_id: &str,
    message_id: i64,
) -> rusqlite::Result<Option<PinnedMessageRow>> {
    let Some((current_message_id, message_ordinal)) =
        get_pin_message_lookup(conn, session_id, message_id)?
    else {
        return Ok(None);
    };

    conn.execute(
        "INSERT INTO pinned_messages (session_id, message_id, message_ordinal)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(session_id, message_ordinal)
         DO UPDATE SET message_id = excluded.message_id",
        (session_id, current_message_id, message_ordinal),
    )?;

    let mut stmt = conn.prepare(
        "SELECT
            p.id,
            p.session_id,
            m.id as message_id,
            p.message_ordinal,
            m.role,
            m.content,
            m.timestamp as message_timestamp,
            p.created_at,
            bs.project as session_project,
            bs.agent as session_agent,
            bs.first_message as session_first_message
         FROM pinned_messages p
         LEFT JOIN messages m
           ON m.session_id = p.session_id
          AND m.ordinal = p.message_ordinal
         LEFT JOIN browsing_sessions bs
           ON bs.id = p.session_id
         WHERE p.session_id = ?1 AND p.message_ordinal = ?2",
    )?;
    let mut rows = stmt.query((session_id, message_ordinal))?;
    match rows.next()? {
        Some(row) => Ok(Some(PinnedMessageRow::from_row(row)?)),
        None => Ok(None),
    }
}

pub fn unpin_message(
    conn: &Connection,
    session_id: &str,
    message_id: i64,
) -> rusqlite::Result<(bool, Option<i64>)> {
    if let Some((_, message_ordinal)) = get_pin_message_lookup(conn, session_id, message_id)? {
        let removed = conn.execute(
            "DELETE FROM pinned_messages
             WHERE session_id = ?1 AND message_ordinal = ?2",
            (session_id, message_ordinal),
        )? > 0;
        return Ok((removed, Some(message_ordinal)));
    }

    let stored_pin = conn
        .query_row(
            "SELECT message_ordinal
             FROM pinned_messages
             WHERE session_id = ?1 AND message_id = ?2",
            (session_id, message_id),
            |row| row.get::<_, i64>(0),
        )
        .ok();

    let removed = conn.execute(
        "DELETE FROM pinned_messages
         WHERE session_id = ?1 AND message_id = ?2",
        (session_id, message_id),
    )? > 0;
    Ok((removed, stored_pin))
}

pub fn list_live_sessions(
    conn: &Connection,
    params: &LiveSessionsListParams,
) -> rusqlite::Result<LiveSessionsResult> {
    let limit = params.limit.unwrap_or(200).clamp(1, 500);
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(project) = params.project.as_deref() {
        conditions.push("project = ?".into());
        values.push(SqlValue::Text(project.to_string()));
    }
    if let Some(agent) = params.agent.as_deref() {
        conditions.push("agent = ?".into());
        values.push(SqlValue::Text(agent.to_string()));
    }
    if let Some(live_status) = params.live_status.as_deref() {
        conditions.push("live_status = ?".into());
        values.push(SqlValue::Text(live_status.to_string()));
    }
    if let Some(fidelity) = params.fidelity.as_deref() {
        conditions.push("fidelity = ?".into());
        values.push(SqlValue::Text(fidelity.to_string()));
    }
    if params.active_only {
        conditions.push("COALESCE(live_status, '') IN ('live', 'active')".into());
    }

    let filter_where = where_clause(&conditions);
    let filter_refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let total_sql = format!("SELECT COUNT(*) FROM browsing_sessions {filter_where}");
    let total: i64 = conn.query_row(&total_sql, filter_refs.as_slice(), |row| row.get(0))?;

    if let Some(cursor) = decode_time_cursor(params.cursor.as_deref()) {
        conditions.push(
            "(COALESCE(last_item_at, started_at, '') < ? OR (COALESCE(last_item_at, started_at, '') = ? AND id < ?))"
                .into(),
        );
        values.push(SqlValue::Text(cursor.sort_at.clone()));
        values.push(SqlValue::Text(cursor.sort_at));
        values.push(SqlValue::Text(cursor.id));
    }

    let sql = format!(
        "SELECT * FROM browsing_sessions {} ORDER BY COALESCE(last_item_at, started_at) DESC, id DESC LIMIT ?",
        where_clause(&conditions)
    );
    values.push(SqlValue::Integer(limit));
    let data = query_browsing_sessions(conn, &sql, &values)?;
    let cursor = data
        .last()
        .and_then(|last| {
            last.last_item_at
                .as_ref()
                .or(last.started_at.as_ref())
                .map(|sort_at| {
                    encode_time_cursor(TimeCursor {
                        sort_at: sort_at.clone(),
                        id: last.id.clone(),
                    })
                })
        })
        .filter(|_| data.len() as i64 == limit);

    Ok(SessionsResult {
        data,
        total,
        cursor,
    })
}

pub fn get_live_session(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<BrowsingSessionRow>> {
    get_browsing_session(conn, id)
}

pub fn get_session_turns(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<LiveTurnRow>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM session_turns
         WHERE session_id = ?1
         ORDER BY COALESCE(started_at, created_at), id",
    )?;
    let rows = stmt.query_map([session_id], LiveTurnRow::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_session_items(
    conn: &Connection,
    session_id: &str,
    params: &LiveItemsListParams,
) -> rusqlite::Result<LiveItemsResult> {
    let limit = params.limit.unwrap_or(200).clamp(1, 500);
    let mut conditions = vec!["session_id = ?".to_string()];
    let mut values = vec![SqlValue::Text(session_id.to_string())];

    if !params.kinds.is_empty() {
        conditions.push(format!(
            "kind IN ({})",
            params
                .kinds
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ")
        ));
        values.extend(params.kinds.iter().cloned().map(SqlValue::Text));
    }

    if let Some(cursor) = params
        .cursor
        .as_deref()
        .and_then(|raw| raw.parse::<i64>().ok())
    {
        conditions.push("id > ?".into());
        values.push(SqlValue::Integer(cursor));
    }

    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session_items WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;

    let sql = format!(
        "SELECT * FROM session_items {} ORDER BY id ASC LIMIT ?",
        where_clause(&conditions)
    );
    values.push(SqlValue::Integer(limit));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), LiveItemRow::from_row)?;
    let data = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let cursor = data
        .last()
        .map(|item| item.id.to_string())
        .filter(|_| data.len() as i64 == limit);

    Ok(LiveItemsResult {
        data,
        total,
        cursor,
    })
}

pub fn search_messages(
    conn: &Connection,
    params: &SearchParams,
) -> rusqlite::Result<SearchResultPage> {
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let sort = match params.sort.as_deref() {
        Some("relevance") => "relevance",
        _ => "recent",
    };
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(project) = params.project.as_deref() {
        conditions.push("bs.project = ?".into());
        values.push(SqlValue::Text(project.to_string()));
    }
    if let Some(agent) = params.agent.as_deref() {
        conditions.push("bs.agent = ?".into());
        values.push(SqlValue::Text(agent.to_string()));
    }

    let join_filter = if conditions.is_empty() {
        String::new()
    } else {
        format!(" AND {}", conditions.join(" AND "))
    };

    let mut count_params = vec![SqlValue::Text(params.q.clone())];
    count_params.extend(values.clone());
    let count_refs: Vec<&dyn ToSql> = count_params
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect();
    let count_sql = format!(
        "SELECT COUNT(*)
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN browsing_sessions bs ON bs.id = m.session_id
         WHERE messages_fts MATCH ?{join_filter}"
    );
    let total: i64 = conn.query_row(&count_sql, count_refs.as_slice(), |row| row.get(0))?;

    let (data, cursor) = if sort == "relevance" {
        let cursor_state = decode_relevance_cursor(params.cursor.as_deref());
        let offset_condition = if cursor_state.is_some() {
            " AND (
                bm25(messages_fts) > ?
                OR (bm25(messages_fts) = ? AND m.id < ?)
            )"
        } else {
            ""
        };
        let mut query_params = vec![SqlValue::Text(params.q.clone())];
        query_params.extend(values.clone());
        if let Some(cursor_state) = cursor_state {
            query_params.push(SqlValue::Real(cursor_state.rank));
            query_params.push(SqlValue::Real(cursor_state.rank));
            query_params.push(SqlValue::Integer(cursor_state.message_id));
        }
        query_params.push(SqlValue::Integer(limit));

        let sql = format!(
            "SELECT
                m.session_id,
                m.id as message_id,
                m.ordinal as message_ordinal,
                m.role as message_role,
                snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet,
                bs.project as session_project,
                bs.agent as session_agent,
                bs.started_at as session_started_at,
                bs.ended_at as session_ended_at,
                bs.first_message as session_first_message,
                bm25(messages_fts) as search_rank
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             JOIN browsing_sessions bs ON bs.id = m.session_id
             WHERE messages_fts MATCH ?{join_filter}{offset_condition}
             ORDER BY search_rank ASC, m.id DESC
             LIMIT ?"
        );
        let query_refs: Vec<&dyn ToSql> = query_params
            .iter()
            .map(|value| value as &dyn ToSql)
            .collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(query_refs.as_slice(), |row| {
            Ok((
                SearchResultRow::from_row(row)?,
                row.get::<_, Option<f64>>("search_rank")?,
            ))
        })?;
        let ranked = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let cursor = ranked
            .last()
            .and_then(|(row, rank)| {
                rank.map(|rank| {
                    encode_relevance_cursor(RelevanceCursor {
                        rank,
                        message_id: row.message_id,
                    })
                })
            })
            .filter(|_| ranked.len() as i64 == limit);
        let data = ranked.into_iter().map(|(row, _)| row).collect::<Vec<_>>();
        (data, cursor)
    } else {
        let cursor_value = params
            .cursor
            .as_deref()
            .and_then(|raw| raw.parse::<i64>().ok());
        let offset_condition = if cursor_value.is_some() {
            " AND m.id < ?"
        } else {
            ""
        };
        let mut query_params = vec![SqlValue::Text(params.q.clone())];
        query_params.extend(values);
        if let Some(cursor) = cursor_value {
            query_params.push(SqlValue::Integer(cursor));
        }
        query_params.push(SqlValue::Integer(limit));

        let sql = format!(
            "SELECT
                m.session_id,
                m.id as message_id,
                m.ordinal as message_ordinal,
                m.role as message_role,
                snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet,
                bs.project as session_project,
                bs.agent as session_agent,
                bs.started_at as session_started_at,
                bs.ended_at as session_ended_at,
                bs.first_message as session_first_message
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             JOIN browsing_sessions bs ON bs.id = m.session_id
             WHERE messages_fts MATCH ?{join_filter}{offset_condition}
             ORDER BY m.id DESC
             LIMIT ?"
        );
        let query_refs: Vec<&dyn ToSql> = query_params
            .iter()
            .map(|value| value as &dyn ToSql)
            .collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(query_refs.as_slice(), SearchResultRow::from_row)?;
        let data = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let cursor = data
            .last()
            .map(|row| row.message_id.to_string())
            .filter(|_| data.len() as i64 == limit);
        (data, cursor)
    };

    Ok(SearchResultPage {
        data,
        total,
        cursor,
    })
}

pub fn get_analytics_summary(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<AnalyticsSummary> {
    let (where_sql, values) = analytics_where(params, None, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            COUNT(*) as total_sessions,
            COALESCE(SUM(message_count), 0) as total_messages,
            COALESCE(SUM(user_message_count), 0) as total_user_messages,
            MIN(started_at) as earliest,
            MAX(started_at) as latest
         FROM browsing_sessions {where_sql}"
    );
    let row = conn.query_row(&sql, refs.as_slice(), |row| {
        Ok((
            row.get::<_, i64>("total_sessions")?,
            row.get::<_, i64>("total_messages")?,
            row.get::<_, i64>("total_user_messages")?,
            row.get::<_, Option<String>>("earliest")?,
            row.get::<_, Option<String>>("latest")?,
        ))
    })?;

    let (daily_average_sessions, daily_average_messages) = match (&row.3, &row.4) {
        (Some(earliest), Some(latest)) => {
            let days = day_span(earliest, latest).unwrap_or(1).max(1) as f64;
            (
                ((row.0 as f64 / days) * 100.0).round() / 100.0,
                ((row.1 as f64 / days) * 100.0).round() / 100.0,
            )
        }
        _ => (0.0, 0.0),
    };

    Ok(AnalyticsSummary {
        total_sessions: row.0,
        total_messages: row.1,
        total_user_messages: row.2,
        daily_average_sessions,
        daily_average_messages,
        date_range: AnalyticsDateRange {
            earliest: row.3,
            latest: row.4,
        },
        coverage: get_analytics_coverage(conn, params, "all_sessions")?,
    })
}

pub fn get_analytics_activity(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<ActivityDataPoint>> {
    let (where_sql, values) = analytics_where(params, None, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            date(started_at) as date,
            COUNT(*) as sessions,
            COALESCE(SUM(message_count), 0) as messages,
            COALESCE(SUM(user_message_count), 0) as user_messages
         FROM browsing_sessions
         {where_sql}
         GROUP BY date(started_at)
         ORDER BY date"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), ActivityDataPoint::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_analytics_projects(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<ProjectBreakdown>> {
    let (mut where_sql, values) = analytics_where(params, None, true);
    if where_sql.is_empty() {
        where_sql = "WHERE project IS NOT NULL".to_string();
    } else {
        where_sql.push_str(" AND project IS NOT NULL");
    }
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            project,
            COUNT(*) as session_count,
            COALESCE(SUM(message_count), 0) as message_count,
            COALESCE(SUM(user_message_count), 0) as user_message_count
         FROM browsing_sessions
         {where_sql}
         GROUP BY project
         ORDER BY message_count DESC, session_count DESC, project ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), ProjectBreakdown::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_analytics_tools(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<ToolUsageStat>> {
    let (where_sql, values) = analytics_where(params, Some("bs"), true);
    let sql_where = if where_sql.is_empty() {
        format!("WHERE {}", tool_analytics_capable_condition(Some("bs")))
    } else {
        format!(
            "{} AND {}",
            where_sql,
            tool_analytics_capable_condition(Some("bs"))
        )
    };
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            tc.tool_name,
            tc.category,
            COUNT(*) as count
         FROM tool_calls tc
         JOIN browsing_sessions bs ON bs.id = tc.session_id
         {sql_where}
         GROUP BY tc.tool_name, tc.category
         ORDER BY count DESC, tc.tool_name ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), ToolUsageStat::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_analytics_hour_of_week(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<HourOfWeekDataPoint>> {
    let (where_sql, values) = analytics_where(params, None, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            ((CAST(strftime('%w', started_at) AS INTEGER) + 6) % 7) as day_of_week,
            CAST(strftime('%H', started_at) AS INTEGER) as hour_of_day,
            COUNT(*) as session_count,
            COALESCE(SUM(message_count), 0) as message_count,
            COALESCE(SUM(user_message_count), 0) as user_message_count
         FROM browsing_sessions
         {where_sql}
         GROUP BY day_of_week, hour_of_day
         ORDER BY day_of_week, hour_of_day"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), HourOfWeekDataPoint::from_row)?;
    let mut buckets = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|row| ((row.day_of_week, row.hour_of_day), row))
        .collect::<HashMap<_, _>>();

    let mut grid = Vec::with_capacity(7 * 24);
    for day in 0..7 {
        for hour in 0..24 {
            grid.push(buckets.remove(&(day, hour)).unwrap_or(HourOfWeekDataPoint {
                day_of_week: day,
                hour_of_day: hour,
                session_count: 0,
                message_count: 0,
                user_message_count: 0,
            }));
        }
    }

    Ok(grid)
}

pub fn get_analytics_top_sessions(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<TopSessionStat>> {
    let limit = params.limit.unwrap_or(10).clamp(1, 50);
    let (where_sql, mut values) = analytics_where(params, Some("bs"), true);
    values.push(SqlValue::Integer(limit));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            bs.id,
            bs.project,
            bs.agent,
            bs.started_at,
            bs.ended_at,
            bs.message_count,
            bs.user_message_count,
            COALESCE(tc.tool_call_count, 0) as tool_call_count,
            bs.fidelity
         FROM browsing_sessions bs
         LEFT JOIN (
            SELECT session_id, COUNT(*) as tool_call_count
            FROM tool_calls
            GROUP BY session_id
         ) tc ON tc.session_id = bs.id
         {where_sql}
         ORDER BY bs.message_count DESC, bs.started_at DESC, bs.id DESC
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), TopSessionStat::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_analytics_velocity(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<VelocityMetrics> {
    let (where_sql, values) = analytics_where(params, None, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            COUNT(*) as total_sessions,
            COALESCE(SUM(message_count), 0) as total_messages,
            COALESCE(SUM(user_message_count), 0) as total_user_messages,
            COUNT(DISTINCT date(started_at)) as active_days,
            MIN(started_at) as earliest,
            MAX(started_at) as latest
         FROM browsing_sessions
         {where_sql}"
    );
    let row = conn.query_row(&sql, refs.as_slice(), |row| {
        Ok((
            row.get::<_, i64>("total_sessions")?,
            row.get::<_, i64>("total_messages")?,
            row.get::<_, i64>("total_user_messages")?,
            row.get::<_, i64>("active_days")?,
            row.get::<_, Option<String>>("earliest")?,
            row.get::<_, Option<String>>("latest")?,
        ))
    })?;

    let span_days = match (&row.4, &row.5) {
        (Some(earliest), Some(latest)) => day_span(earliest, latest).unwrap_or(0).max(1),
        _ => 0,
    };
    let active_days = if row.0 > 0 { row.3 } else { 0 };

    Ok(VelocityMetrics {
        total_sessions: row.0,
        total_messages: row.1,
        total_user_messages: row.2,
        active_days,
        span_days,
        sessions_per_active_day: if row.0 > 0 {
            round_metric(row.0 as f64 / row.3.max(1) as f64)
        } else {
            0.0
        },
        messages_per_active_day: if row.0 > 0 {
            round_metric(row.1 as f64 / row.3.max(1) as f64)
        } else {
            0.0
        },
        sessions_per_calendar_day: if row.0 > 0 {
            round_metric(row.0 as f64 / span_days.max(1) as f64)
        } else {
            0.0
        },
        messages_per_calendar_day: if row.0 > 0 {
            round_metric(row.1 as f64 / span_days.max(1) as f64)
        } else {
            0.0
        },
        average_messages_per_session: if row.0 > 0 {
            round_metric(row.1 as f64 / row.0 as f64)
        } else {
            0.0
        },
        average_user_messages_per_session: if row.0 > 0 {
            round_metric(row.2 as f64 / row.0 as f64)
        } else {
            0.0
        },
        coverage: get_analytics_coverage(conn, params, "all_sessions")?,
    })
}

pub fn get_analytics_agents(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<AgentComparisonRow>> {
    let (where_sql, values) = analytics_where(params, None, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let fidelity_expr = analytics_fidelity_expr(None);
    let tool_analytics_condition = tool_analytics_capable_condition(None);
    let sql = format!(
        "SELECT
            agent,
            COUNT(*) as session_count,
            COALESCE(SUM(message_count), 0) as message_count,
            COALESCE(SUM(user_message_count), 0) as user_message_count,
            ROUND(COALESCE(1.0 * SUM(message_count) / NULLIF(COUNT(*), 0), 0), 2) as average_messages_per_session,
            COALESCE(SUM(CASE WHEN {fidelity_expr} = 'full' THEN 1 ELSE 0 END), 0) as full_fidelity_sessions,
            COALESCE(SUM(CASE WHEN {fidelity_expr} = 'summary' THEN 1 ELSE 0 END), 0) as summary_fidelity_sessions,
            COALESCE(SUM(CASE WHEN {tool_analytics_condition} THEN 1 ELSE 0 END), 0) as tool_analytics_capable_sessions,
            MIN(started_at) as first_started_at,
            MAX(started_at) as last_started_at
         FROM browsing_sessions
         {where_sql}
         GROUP BY agent
         ORDER BY message_count DESC, session_count DESC, agent ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), AgentComparisonRow::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_usage_coverage(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<UsageCoverage> {
    let (where_sql, values) = usage_where(params, Some("e"));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let metrics_condition = usage_metrics_condition(Some("e"));

    let summary_sql = format!(
        "SELECT
            COUNT(*) as matching_events,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN 1 ELSE 0 END), 0) as usage_events,
            COUNT(DISTINCT e.session_id) as matching_sessions,
            COUNT(DISTINCT CASE WHEN {metrics_condition} THEN e.session_id END) as usage_sessions
         FROM events e
         {where_sql}"
    );
    let summary = conn.query_row(&summary_sql, refs.as_slice(), |row| {
        Ok((
            row.get::<_, i64>("matching_events")?,
            row.get::<_, i64>("usage_events")?,
            row.get::<_, i64>("matching_sessions")?,
            row.get::<_, i64>("usage_sessions")?,
        ))
    })?;

    let source_sql = format!(
        "SELECT
            COALESCE(NULLIF(e.source, ''), 'api') as source,
            COUNT(*) as event_count,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN 1 ELSE 0 END), 0) as usage_event_count,
            COUNT(DISTINCT CASE WHEN {metrics_condition} THEN e.session_id END) as session_count,
            ROUND(COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.cost_usd ELSE 0 END), 0), 6) as cost_usd,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.tokens_in ELSE 0 END), 0) as input_tokens,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.tokens_out ELSE 0 END), 0) as output_tokens,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.cache_read_tokens ELSE 0 END), 0) as cache_read_tokens,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.cache_write_tokens ELSE 0 END), 0) as cache_write_tokens
         FROM events e
         {where_sql}
         GROUP BY source
         ORDER BY source ASC"
    );
    let mut stmt = conn.prepare(&source_sql)?;
    let rows = stmt.query_map(refs.as_slice(), UsageSourceBreakdown::from_row)?;
    let source_breakdown = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let sources_with_usage = source_breakdown
        .iter()
        .filter(|row| row.usage_event_count > 0)
        .count() as i64;

    Ok(UsageCoverage {
        metric_scope: "event_usage".to_string(),
        matching_events: summary.0,
        usage_events: summary.1,
        missing_usage_events: (summary.0 - summary.1).max(0),
        matching_sessions: summary.2,
        usage_sessions: summary.3,
        sources_with_usage,
        source_breakdown,
        note: "Usage is derived from ingested events with cost or token data. Sessions without usage-bearing events are excluded from totals but still reflected in coverage.".to_string(),
    })
}

pub fn get_usage_summary(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<UsageSummary> {
    let (where_sql, values) = usage_where(params, Some("e"));
    let usage_where = append_usage_metrics_condition(where_sql, Some("e"));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let timestamp_expr = usage_timestamp_expr(Some("e"));

    let summary_sql = format!(
        "SELECT
            ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as total_cost_usd,
            COALESCE(SUM(e.tokens_in), 0) as total_input_tokens,
            COALESCE(SUM(e.tokens_out), 0) as total_output_tokens,
            COALESCE(SUM(e.cache_read_tokens), 0) as total_cache_read_tokens,
            COALESCE(SUM(e.cache_write_tokens), 0) as total_cache_write_tokens,
            COUNT(*) as total_usage_events,
            COUNT(DISTINCT e.session_id) as total_sessions,
            COUNT(DISTINCT date({timestamp_expr})) as active_days,
            MIN({timestamp_expr}) as earliest,
            MAX({timestamp_expr}) as latest
         FROM events e
         {usage_where}"
    );
    let row = conn.query_row(&summary_sql, refs.as_slice(), |row| {
        Ok((
            row.get::<_, f64>("total_cost_usd")?,
            row.get::<_, i64>("total_input_tokens")?,
            row.get::<_, i64>("total_output_tokens")?,
            row.get::<_, i64>("total_cache_read_tokens")?,
            row.get::<_, i64>("total_cache_write_tokens")?,
            row.get::<_, i64>("total_usage_events")?,
            row.get::<_, i64>("total_sessions")?,
            row.get::<_, i64>("active_days")?,
            row.get::<_, Option<String>>("earliest")?,
            row.get::<_, Option<String>>("latest")?,
        ))
    })?;

    let peak_sql = format!(
        "SELECT
            date({timestamp_expr}) as date,
            ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd
         FROM events e
         {usage_where}
         GROUP BY date({timestamp_expr})
         ORDER BY cost_usd DESC, date DESC
         LIMIT 1"
    );
    let peak_day = conn
        .query_row(&peak_sql, refs.as_slice(), |row| {
            Ok(UsagePeakDay {
                date: row.get("date")?,
                cost_usd: row.get("cost_usd")?,
            })
        })
        .unwrap_or(UsagePeakDay {
            date: None,
            cost_usd: 0.0,
        });

    let span_days = match (&row.8, &row.9) {
        (Some(earliest), Some(latest)) => day_span(earliest, latest).unwrap_or(0).max(1),
        _ => 0,
    };

    Ok(UsageSummary {
        total_cost_usd: row.0,
        total_input_tokens: row.1,
        total_output_tokens: row.2,
        total_cache_read_tokens: row.3,
        total_cache_write_tokens: row.4,
        total_usage_events: row.5,
        total_sessions: row.6,
        active_days: if row.5 > 0 { row.7 } else { 0 },
        span_days,
        average_cost_per_active_day: if row.5 > 0 {
            round_metric(row.0 / row.7.max(1) as f64)
        } else {
            0.0
        },
        average_cost_per_session: if row.6 > 0 {
            round_metric(row.0 / row.6 as f64)
        } else {
            0.0
        },
        peak_day,
        coverage: get_usage_coverage(conn, params)?,
    })
}

pub fn get_usage_daily(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<UsageDailyPoint>> {
    let (where_sql, values) = usage_where(params, Some("e"));
    let usage_where = append_usage_metrics_condition(where_sql, Some("e"));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let timestamp_expr = usage_timestamp_expr(Some("e"));

    let sql = format!(
        "SELECT
            date({timestamp_expr}) as date,
            ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
            COALESCE(SUM(e.tokens_in), 0) as input_tokens,
            COALESCE(SUM(e.tokens_out), 0) as output_tokens,
            COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
            COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
            COUNT(*) as usage_events,
            COUNT(DISTINCT e.session_id) as session_count
         FROM events e
         {usage_where}
         GROUP BY date({timestamp_expr})
         ORDER BY date ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), UsageDailyPoint::from_row)?;
    let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    let bounds = resolve_usage_date_bounds(
        params,
        raw.first().map(|row| row.date.as_str()),
        raw.last().map(|row| row.date.as_str()),
    );
    let Some((from, to)) = bounds else {
        return Ok(raw);
    };

    let by_date = raw
        .into_iter()
        .map(|row| (row.date.clone(), row))
        .collect::<HashMap<_, _>>();
    let mut data = Vec::new();
    for date in enumerate_date_range(from, to) {
        data.push(by_date.get(&date).cloned().unwrap_or(UsageDailyPoint {
            date,
            cost_usd: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            usage_events: 0,
            session_count: 0,
        }));
    }
    Ok(data)
}

pub fn get_usage_projects(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<UsageProjectBreakdown>> {
    let (where_sql, values) = usage_where(params, Some("e"));
    let usage_where = append_usage_metrics_condition(where_sql, Some("e"));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let project_expr = usage_project_expr(Some("e"));

    let sql = format!(
        "SELECT
            {project_expr} as project,
            ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
            COALESCE(SUM(e.tokens_in), 0) as input_tokens,
            COALESCE(SUM(e.tokens_out), 0) as output_tokens,
            COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
            COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
            COUNT(*) as usage_events,
            COUNT(DISTINCT e.session_id) as session_count
         FROM events e
         {usage_where}
         GROUP BY project
         ORDER BY cost_usd DESC, input_tokens DESC, project ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), UsageProjectBreakdown::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_usage_models(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<UsageModelBreakdown>> {
    let (where_sql, values) = usage_where(params, Some("e"));
    let usage_where = append_usage_metrics_condition(where_sql, Some("e"));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let model_expr = usage_model_expr(Some("e"));

    let sql = format!(
        "SELECT
            {model_expr} as model,
            ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
            COALESCE(SUM(e.tokens_in), 0) as input_tokens,
            COALESCE(SUM(e.tokens_out), 0) as output_tokens,
            COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
            COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
            COUNT(*) as usage_events,
            COUNT(DISTINCT e.session_id) as session_count
         FROM events e
         {usage_where}
         GROUP BY model
         ORDER BY cost_usd DESC, input_tokens DESC, model ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), UsageModelBreakdown::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_usage_agents(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<UsageAgentBreakdown>> {
    let (where_sql, values) = usage_where(params, Some("e"));
    let usage_where = append_usage_metrics_condition(where_sql, Some("e"));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let agent_expr = usage_agent_expr(Some("e"));

    let sql = format!(
        "SELECT
            {agent_expr} as agent,
            ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
            COALESCE(SUM(e.tokens_in), 0) as input_tokens,
            COALESCE(SUM(e.tokens_out), 0) as output_tokens,
            COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
            COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
            COUNT(*) as usage_events,
            COUNT(DISTINCT e.session_id) as session_count
         FROM events e
         {usage_where}
         GROUP BY agent
         ORDER BY cost_usd DESC, input_tokens DESC, agent ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), UsageAgentBreakdown::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_usage_top_sessions(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<UsageTopSessionRow>> {
    let limit = params.limit.unwrap_or(10).clamp(1, 50);
    let (where_sql, mut values) = usage_where(params, Some("e"));
    values.push(SqlValue::Integer(limit));
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let metrics_condition = usage_metrics_condition(Some("e"));
    let timestamp_expr = usage_timestamp_expr(Some("e"));

    let sql = format!(
        "SELECT
            e.session_id as id,
            COALESCE(MAX(NULLIF(e.project, '')), MAX(bs.project), MAX(s.project)) as project,
            COALESCE(MAX(e.agent_type), MAX(s.agent_type), MAX(bs.agent)) as agent,
            COALESCE(MAX(bs.started_at), MAX(s.started_at), MIN({timestamp_expr})) as started_at,
            COALESCE(MAX(bs.ended_at), MAX(s.ended_at), MAX({timestamp_expr})) as ended_at,
            MAX({timestamp_expr}) as last_activity_at,
            MAX(bs.message_count) as message_count,
            MAX(bs.user_message_count) as user_message_count,
            MAX(bs.fidelity) as fidelity,
            ROUND(COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.cost_usd ELSE 0 END), 0), 6) as cost_usd,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.tokens_in ELSE 0 END), 0) as input_tokens,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.tokens_out ELSE 0 END), 0) as output_tokens,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.cache_read_tokens ELSE 0 END), 0) as cache_read_tokens,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN e.cache_write_tokens ELSE 0 END), 0) as cache_write_tokens,
            COUNT(*) as event_count,
            COALESCE(SUM(CASE WHEN {metrics_condition} THEN 1 ELSE 0 END), 0) as usage_events,
            CASE WHEN MAX(bs.id) IS NULL THEN 0 ELSE 1 END as browsing_session_available
         FROM events e
         LEFT JOIN sessions s ON s.id = e.session_id
         LEFT JOIN browsing_sessions bs ON bs.id = e.session_id
         {where_sql}
         GROUP BY e.session_id
         HAVING COALESCE(SUM(CASE WHEN {metrics_condition} THEN 1 ELSE 0 END), 0) > 0
         ORDER BY cost_usd DESC, last_activity_at DESC, e.session_id DESC
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), UsageTopSessionRow::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_distinct_projects(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT project FROM browsing_sessions WHERE project IS NOT NULL ORDER BY project",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_distinct_agents(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT agent FROM browsing_sessions ORDER BY agent")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

fn map_browsing_session(row: BrowsingSessionDbRow) -> BrowsingSessionRow {
    BrowsingSessionRow {
        id: row.id,
        project: row.project,
        agent: row.agent,
        first_message: row.first_message,
        started_at: row.started_at,
        ended_at: row.ended_at,
        message_count: row.message_count,
        user_message_count: row.user_message_count,
        parent_session_id: row.parent_session_id,
        relationship_type: row.relationship_type,
        live_status: row.live_status,
        last_item_at: row.last_item_at,
        integration_mode: row.integration_mode.clone(),
        fidelity: row.fidelity.clone(),
        capabilities: infer_projection_capabilities(
            row.capabilities_json.as_deref(),
            row.fidelity.as_deref(),
            row.integration_mode.as_deref(),
        ),
        file_path: row.file_path,
        file_size: row.file_size,
        file_hash: row.file_hash,
    }
}

fn infer_projection_capabilities(
    capabilities_json: Option<&str>,
    fidelity: Option<&str>,
    integration_mode: Option<&str>,
) -> Option<ProjectionCapabilities> {
    let fallback = projection_capability_fallback(fidelity, integration_mode);
    match capabilities_json {
        Some(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(value) => Some(normalize_projection_capabilities(Some(&value), &fallback)),
            Err(_) => Some(fallback),
        },
        None if fidelity.is_some() || integration_mode.is_some() => Some(fallback),
        None => None,
    }
}

fn projection_capability_fallback(
    fidelity: Option<&str>,
    integration_mode: Option<&str>,
) -> ProjectionCapabilities {
    if integration_mode == Some("claude-jsonl") || fidelity == Some("full") {
        ProjectionCapabilities {
            history: "full".into(),
            search: "full".into(),
            tool_analytics: "full".into(),
            live_items: "full".into(),
        }
    } else {
        ProjectionCapabilities {
            history: "none".into(),
            search: "none".into(),
            tool_analytics: "none".into(),
            live_items: "summary".into(),
        }
    }
}

fn normalize_projection_capabilities(
    value: Option<&Value>,
    fallback: &ProjectionCapabilities,
) -> ProjectionCapabilities {
    let Some(Value::Object(record)) = value else {
        return fallback.clone();
    };

    let mut normalized = HashMap::new();
    for key in ["history", "search", "tool_analytics", "live_items"] {
        if let Some(Value::String(level)) = record.get(key)
            && matches!(level.as_str(), "none" | "summary" | "full")
        {
            normalized.insert(key, level.clone());
        }
    }

    ProjectionCapabilities {
        history: normalized
            .remove("history")
            .unwrap_or_else(|| fallback.history.clone()),
        search: normalized
            .remove("search")
            .unwrap_or_else(|| fallback.search.clone()),
        tool_analytics: normalized
            .remove("tool_analytics")
            .unwrap_or_else(|| fallback.tool_analytics.clone()),
        live_items: normalized
            .remove("live_items")
            .unwrap_or_else(|| fallback.live_items.clone()),
    }
}

fn query_browsing_sessions(
    conn: &Connection,
    sql: &str,
    values: &[SqlValue],
) -> rusqlite::Result<Vec<BrowsingSessionRow>> {
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(refs.as_slice(), |row| {
        Ok(map_browsing_session(BrowsingSessionDbRow::from_row(row)?))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

fn qualify_column(alias: Option<&str>, column: &str) -> String {
    match alias {
        Some(alias) => format!("{alias}.{column}"),
        None => column.to_string(),
    }
}

fn analytics_where(
    params: &AnalyticsParams,
    alias: Option<&str>,
    include_agent: bool,
) -> (String, Vec<SqlValue>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(project) = params.project.as_deref() {
        conditions.push(format!("{} = ?", qualify_column(alias, "project")));
        values.push(SqlValue::Text(project.to_string()));
    }
    if include_agent && let Some(agent) = params.agent.as_deref() {
        conditions.push(format!("{} = ?", qualify_column(alias, "agent")));
        values.push(SqlValue::Text(agent.to_string()));
    }
    if let Some(date_from) = params.date_from.as_deref() {
        conditions.push(format!("{} >= ?", qualify_column(alias, "started_at")));
        values.push(SqlValue::Text(date_from.to_string()));
    }
    if let Some(date_to) = params.date_to.as_deref() {
        conditions.push(format!(
            "{} < date(?, '+1 day')",
            qualify_column(alias, "started_at")
        ));
        values.push(SqlValue::Text(date_to.to_string()));
    }

    (where_clause(&conditions), values)
}

fn analytics_fidelity_expr(alias: Option<&str>) -> String {
    let fidelity_column = qualify_column(alias, "fidelity");
    let integration_mode_column = qualify_column(alias, "integration_mode");
    format!(
        "CASE
            WHEN {fidelity_column} = 'full' THEN 'full'
            WHEN {fidelity_column} = 'summary' THEN 'summary'
            WHEN {integration_mode_column} = 'claude-jsonl' THEN 'full'
            ELSE 'unknown'
        END"
    )
}

fn analytics_capability_expr(capability: &str, alias: Option<&str>) -> String {
    let capabilities_column = qualify_column(alias, "capabilities_json");
    let fidelity_column = qualify_column(alias, "fidelity");
    let integration_mode_column = qualify_column(alias, "integration_mode");
    format!(
        "COALESCE(
            json_extract({capabilities_column}, '$.{capability}'),
            CASE
                WHEN {integration_mode_column} = 'claude-jsonl' OR {fidelity_column} = 'full' THEN 'full'
                WHEN {fidelity_column} = 'summary' THEN 'none'
                ELSE 'unknown'
            END
        )"
    )
}

fn tool_analytics_capable_condition(alias: Option<&str>) -> String {
    format!(
        "{} IN ('summary', 'full')",
        analytics_capability_expr("tool_analytics", alias)
    )
}

fn round_metric(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn get_analytics_coverage(
    conn: &Connection,
    params: &AnalyticsParams,
    scope: &str,
) -> rusqlite::Result<AnalyticsCoverage> {
    let (where_sql, values) = analytics_where(params, None, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let included_condition = match scope {
        "tool_analytics_capable" => tool_analytics_capable_condition(None),
        _ => "1 = 1".to_string(),
    };
    let fidelity_expr = analytics_fidelity_expr(None);
    let history_expr = analytics_capability_expr("history", None);
    let search_expr = analytics_capability_expr("search", None);
    let tool_analytics_expr = analytics_capability_expr("tool_analytics", None);
    let live_items_expr = analytics_capability_expr("live_items", None);

    let sql = format!(
        "SELECT
            COUNT(*) as matching_sessions,
            COALESCE(SUM(CASE WHEN {included_condition} THEN 1 ELSE 0 END), 0) as included_sessions,
            COALESCE(SUM(CASE WHEN {fidelity_expr} = 'full' THEN 1 ELSE 0 END), 0) as fidelity_full,
            COALESCE(SUM(CASE WHEN {fidelity_expr} = 'summary' THEN 1 ELSE 0 END), 0) as fidelity_summary,
            COALESCE(SUM(CASE WHEN {fidelity_expr} = 'unknown' THEN 1 ELSE 0 END), 0) as fidelity_unknown,
            COALESCE(SUM(CASE WHEN {history_expr} = 'full' THEN 1 ELSE 0 END), 0) as history_full,
            COALESCE(SUM(CASE WHEN {history_expr} = 'summary' THEN 1 ELSE 0 END), 0) as history_summary,
            COALESCE(SUM(CASE WHEN {history_expr} = 'none' THEN 1 ELSE 0 END), 0) as history_none,
            COALESCE(SUM(CASE WHEN {history_expr} = 'unknown' THEN 1 ELSE 0 END), 0) as history_unknown,
            COALESCE(SUM(CASE WHEN {search_expr} = 'full' THEN 1 ELSE 0 END), 0) as search_full,
            COALESCE(SUM(CASE WHEN {search_expr} = 'summary' THEN 1 ELSE 0 END), 0) as search_summary,
            COALESCE(SUM(CASE WHEN {search_expr} = 'none' THEN 1 ELSE 0 END), 0) as search_none,
            COALESCE(SUM(CASE WHEN {search_expr} = 'unknown' THEN 1 ELSE 0 END), 0) as search_unknown,
            COALESCE(SUM(CASE WHEN {tool_analytics_expr} = 'full' THEN 1 ELSE 0 END), 0) as tool_analytics_full,
            COALESCE(SUM(CASE WHEN {tool_analytics_expr} = 'summary' THEN 1 ELSE 0 END), 0) as tool_analytics_summary,
            COALESCE(SUM(CASE WHEN {tool_analytics_expr} = 'none' THEN 1 ELSE 0 END), 0) as tool_analytics_none,
            COALESCE(SUM(CASE WHEN {tool_analytics_expr} = 'unknown' THEN 1 ELSE 0 END), 0) as tool_analytics_unknown,
            COALESCE(SUM(CASE WHEN {live_items_expr} = 'full' THEN 1 ELSE 0 END), 0) as live_items_full,
            COALESCE(SUM(CASE WHEN {live_items_expr} = 'summary' THEN 1 ELSE 0 END), 0) as live_items_summary,
            COALESCE(SUM(CASE WHEN {live_items_expr} = 'none' THEN 1 ELSE 0 END), 0) as live_items_none,
            COALESCE(SUM(CASE WHEN {live_items_expr} = 'unknown' THEN 1 ELSE 0 END), 0) as live_items_unknown
         FROM browsing_sessions
         {where_sql}"
    );

    conn.query_row(&sql, refs.as_slice(), |row| {
        let matching_sessions = row.get::<_, i64>("matching_sessions")?;
        let included_sessions = row.get::<_, i64>("included_sessions")?;
        Ok(AnalyticsCoverage {
            metric_scope: scope.to_string(),
            matching_sessions,
            included_sessions,
            excluded_sessions: (matching_sessions - included_sessions).max(0),
            fidelity_breakdown: AnalyticsFidelityBreakdown {
                full: row.get("fidelity_full")?,
                summary: row.get("fidelity_summary")?,
                unknown: row.get("fidelity_unknown")?,
            },
            capability_breakdown: AnalyticsCoverageCapabilityBreakdown {
                history: AnalyticsCapabilityBreakdown {
                    full: row.get("history_full")?,
                    summary: row.get("history_summary")?,
                    none: row.get("history_none")?,
                    unknown: row.get("history_unknown")?,
                },
                search: AnalyticsCapabilityBreakdown {
                    full: row.get("search_full")?,
                    summary: row.get("search_summary")?,
                    none: row.get("search_none")?,
                    unknown: row.get("search_unknown")?,
                },
                tool_analytics: AnalyticsCapabilityBreakdown {
                    full: row.get("tool_analytics_full")?,
                    summary: row.get("tool_analytics_summary")?,
                    none: row.get("tool_analytics_none")?,
                    unknown: row.get("tool_analytics_unknown")?,
                },
                live_items: AnalyticsCapabilityBreakdown {
                    full: row.get("live_items_full")?,
                    summary: row.get("live_items_summary")?,
                    none: row.get("live_items_none")?,
                    unknown: row.get("live_items_unknown")?,
                },
            },
            note: if scope == "tool_analytics_capable" {
                "Only sessions whose capability contract exposes tool analytics are included in this metric."
                    .to_string()
            } else {
                "This metric includes every session matching the current filters, including summary-only sessions."
                    .to_string()
            },
        })
    })
}

fn usage_timestamp_expr(alias: Option<&str>) -> String {
    format!(
        "COALESCE({}, {})",
        qualify_column(alias, "client_timestamp"),
        qualify_column(alias, "created_at")
    )
}

fn usage_project_expr(alias: Option<&str>) -> String {
    format!(
        "COALESCE(NULLIF({}, ''), 'unknown')",
        qualify_column(alias, "project")
    )
}

fn usage_agent_expr(alias: Option<&str>) -> String {
    qualify_column(alias, "agent_type")
}

fn usage_model_expr(alias: Option<&str>) -> String {
    format!(
        "COALESCE(NULLIF({}, ''), 'unknown')",
        qualify_column(alias, "model")
    )
}

fn usage_metrics_condition(alias: Option<&str>) -> String {
    format!(
        "(
            COALESCE({}, 0) > 0
            OR COALESCE({}, 0) > 0
            OR COALESCE({}, 0) > 0
            OR COALESCE({}, 0) > 0
            OR COALESCE({}, 0) > 0
        )",
        qualify_column(alias, "cost_usd"),
        qualify_column(alias, "tokens_in"),
        qualify_column(alias, "tokens_out"),
        qualify_column(alias, "cache_read_tokens"),
        qualify_column(alias, "cache_write_tokens"),
    )
}

fn usage_where(params: &AnalyticsParams, alias: Option<&str>) -> (String, Vec<SqlValue>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    let timestamp_expr = usage_timestamp_expr(alias);

    if let Some(project) = params.project.as_deref() {
        conditions.push(format!("{} = ?", usage_project_expr(alias)));
        values.push(SqlValue::Text(project.to_string()));
    }
    if let Some(agent) = params.agent.as_deref() {
        conditions.push(format!("{} = ?", usage_agent_expr(alias)));
        values.push(SqlValue::Text(agent.to_string()));
    }
    if let Some(date_from) = params.date_from.as_deref() {
        conditions.push(format!("datetime({timestamp_expr}) >= datetime(?)"));
        values.push(SqlValue::Text(date_from.to_string()));
    }
    if let Some(date_to) = params.date_to.as_deref() {
        conditions.push(format!(
            "datetime({timestamp_expr}) < datetime(?, '+1 day')"
        ));
        values.push(SqlValue::Text(date_to.to_string()));
    }

    (where_clause(&conditions), values)
}

fn append_usage_metrics_condition(where_sql: String, alias: Option<&str>) -> String {
    if where_sql.is_empty() {
        format!("WHERE {}", usage_metrics_condition(alias))
    } else {
        format!("{where_sql} AND {}", usage_metrics_condition(alias))
    }
}

fn resolve_usage_date_bounds(
    params: &AnalyticsParams,
    earliest: Option<&str>,
    latest: Option<&str>,
) -> Option<(NaiveDate, NaiveDate)> {
    let from = params
        .date_from
        .as_deref()
        .and_then(parse_date_only)
        .or_else(|| earliest.and_then(parse_date_only))?;
    let to = params
        .date_to
        .as_deref()
        .and_then(parse_date_only)
        .or_else(|| latest.and_then(parse_date_only))?;
    if from > to {
        return None;
    }
    Some((from, to))
}

fn parse_date_only(value: &str) -> Option<NaiveDate> {
    if value.len() >= 10 {
        NaiveDate::parse_from_str(&value[..10], "%Y-%m-%d").ok()
    } else {
        None
    }
}

fn enumerate_date_range(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut dates = Vec::new();
    let mut cursor = from;
    while cursor <= to {
        dates.push(cursor.format("%Y-%m-%d").to_string());
        cursor = cursor.succ_opt().unwrap_or(cursor);
        if dates
            .last()
            .is_some_and(|last| last == &to.format("%Y-%m-%d").to_string())
        {
            break;
        }
    }
    dates
}

fn where_clause(conditions: &[String]) -> String {
    if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    }
}

fn encode_time_cursor(cursor: TimeCursor) -> String {
    let json = serde_json::to_vec(&cursor).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json)
}

fn decode_time_cursor(cursor: Option<&str>) -> Option<TimeCursor> {
    let cursor = cursor?;
    match URL_SAFE_NO_PAD.decode(cursor) {
        Ok(bytes) => serde_json::from_slice::<TimeCursor>(&bytes).ok(),
        Err(_) => Some(TimeCursor {
            sort_at: cursor.to_string(),
            id: "\u{ffff}".to_string(),
        }),
    }
}

fn encode_relevance_cursor(cursor: RelevanceCursor) -> String {
    let json = serde_json::to_vec(&cursor).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json)
}

fn decode_relevance_cursor(cursor: Option<&str>) -> Option<RelevanceCursor> {
    let cursor = cursor?;
    let bytes = URL_SAFE_NO_PAD.decode(cursor).ok()?;
    serde_json::from_slice::<RelevanceCursor>(&bytes).ok()
}

fn day_span(earliest: &str, latest: &str) -> Option<i64> {
    let start = parse_timestamp(earliest)?;
    let end = parse_timestamp(latest)?;
    Some(((end - start).num_days()).max(0) + 1)
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.with_timezone(&Utc));
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Some(DateTime::from_naive_utc_and_offset(parsed, Utc));
    }
    if let Ok(parsed) = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        && let Some(dt) = parsed.and_hms_opt(0, 0, 0)
    {
        return Some(DateTime::from_naive_utc_and_offset(dt, Utc));
    }
    None
}
