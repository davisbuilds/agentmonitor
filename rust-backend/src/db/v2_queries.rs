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
