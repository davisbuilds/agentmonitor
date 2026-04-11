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

#[derive(Debug, Clone, Serialize)]
pub struct SearchResultRow {
    pub session_id: String,
    pub message_id: i64,
    pub message_ordinal: i64,
    pub message_role: String,
    pub snippet: String,
}

impl SearchResultRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            session_id: row.get("session_id")?,
            message_id: row.get("message_id")?,
            message_ordinal: row.get("message_ordinal")?,
            message_role: row.get("message_role")?,
            snippet: row.get("snippet")?,
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
}

impl ActivityDataPoint {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            date: row.get("date")?,
            sessions: row.get("sessions")?,
            messages: row.get("messages")?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectBreakdown {
    pub project: String,
    pub session_count: i64,
    pub message_count: i64,
}

impl ProjectBreakdown {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project: row.get("project")?,
            session_count: row.get("session_count")?,
            message_count: row.get("message_count")?,
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
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct AnalyticsParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub project: Option<String>,
    pub agent: Option<String>,
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
        .and_then(|last| last.started_at.as_ref().map(|started_at| encode_time_cursor(TimeCursor {
            sort_at: started_at.clone(),
            id: last.id.clone(),
        })))
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
        Some(row) => Ok(Some(map_browsing_session(BrowsingSessionDbRow::from_row(row)?))),
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
                .map(|sort_at| encode_time_cursor(TimeCursor {
                    sort_at: sort_at.clone(),
                    id: last.id.clone(),
                }))
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
            params.kinds.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
        ));
        values.extend(params.kinds.iter().cloned().map(SqlValue::Text));
    }

    if let Some(cursor) = params.cursor.as_deref().and_then(|raw| raw.parse::<i64>().ok()) {
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
    let count_refs: Vec<&dyn ToSql> = count_params.iter().map(|value| value as &dyn ToSql).collect();
    let count_sql = format!(
        "SELECT COUNT(*)
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN browsing_sessions bs ON bs.id = m.session_id
         WHERE messages_fts MATCH ?{join_filter}"
    );
    let total: i64 = conn.query_row(&count_sql, count_refs.as_slice(), |row| row.get(0))?;

    let offset_condition = if params.cursor.is_some() {
        " AND m.id < ?"
    } else {
        ""
    };
    let mut query_params = vec![SqlValue::Text(params.q.clone())];
    query_params.extend(values);
    if let Some(cursor) = params.cursor.as_deref().and_then(|raw| raw.parse::<i64>().ok()) {
        query_params.push(SqlValue::Integer(cursor));
    }
    query_params.push(SqlValue::Integer(limit));

    let sql = format!(
        "SELECT
            m.session_id,
            m.id as message_id,
            m.ordinal as message_ordinal,
            m.role as message_role,
            snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN browsing_sessions bs ON bs.id = m.session_id
         WHERE messages_fts MATCH ?{join_filter}{offset_condition}
         ORDER BY m.id DESC
         LIMIT ?"
    );
    let query_refs: Vec<&dyn ToSql> = query_params.iter().map(|value| value as &dyn ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(query_refs.as_slice(), SearchResultRow::from_row)?;
    let data = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let cursor = data
        .last()
        .map(|row| row.message_id.to_string())
        .filter(|_| data.len() as i64 == limit);

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
    let (where_sql, values) = analytics_where(params, true);
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
    })
}

pub fn get_analytics_activity(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<ActivityDataPoint>> {
    let (where_sql, values) = analytics_where(params, true);
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            date(started_at) as date,
            COUNT(*) as sessions,
            COALESCE(SUM(message_count), 0) as messages
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
    let mut conditions = vec!["project IS NOT NULL".to_string()];
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some(date_from) = params.date_from.as_deref() {
        conditions.push("started_at >= ?".into());
        values.push(SqlValue::Text(date_from.to_string()));
    }
    if let Some(date_to) = params.date_to.as_deref() {
        conditions.push("started_at < date(?, '+1 day')".into());
        values.push(SqlValue::Text(date_to.to_string()));
    }
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let sql = format!(
        "SELECT
            project,
            COUNT(*) as session_count,
            COALESCE(SUM(message_count), 0) as message_count
         FROM browsing_sessions
         {}
         GROUP BY project
         ORDER BY message_count DESC",
        where_clause(&conditions)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), ProjectBreakdown::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn get_analytics_tools(
    conn: &Connection,
    params: &AnalyticsParams,
) -> rusqlite::Result<Vec<ToolUsageStat>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some(project) = params.project.as_deref() {
        conditions.push("bs.project = ?".into());
        values.push(SqlValue::Text(project.to_string()));
    }
    if let Some(date_from) = params.date_from.as_deref() {
        conditions.push("bs.started_at >= ?".into());
        values.push(SqlValue::Text(date_from.to_string()));
    }
    if let Some(date_to) = params.date_to.as_deref() {
        conditions.push("bs.started_at < date(?, '+1 day')".into());
        values.push(SqlValue::Text(date_to.to_string()));
    }
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let join_filter = where_clause(&conditions);
    let sql = format!(
        "SELECT
            tc.tool_name,
            tc.category,
            COUNT(*) as count
         FROM tool_calls tc
         JOIN browsing_sessions bs ON bs.id = tc.session_id
         {join_filter}
         GROUP BY tc.tool_name, tc.category
         ORDER BY count DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), ToolUsageStat::from_row)?;
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

fn analytics_where(params: &AnalyticsParams, include_agent: bool) -> (String, Vec<SqlValue>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(project) = params.project.as_deref() {
        conditions.push("project = ?".into());
        values.push(SqlValue::Text(project.to_string()));
    }
    if include_agent && let Some(agent) = params.agent.as_deref() {
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

    (where_clause(&conditions), values)
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
