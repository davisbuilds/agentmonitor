use std::collections::HashMap;

use rusqlite::{Connection, ToSql, params, params_from_iter, types::Value as SqlValue};
use serde::Serialize;

use crate::config::UsageMonitorConfig;
use crate::pricing::{TokenCounts, calculate_cost};

// --- Agents ---

pub fn upsert_agent(conn: &Connection, id: &str, agent_type: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO agents (id, agent_type)
         VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')",
        params![id, agent_type],
    )?;
    Ok(())
}

// --- Sessions ---

pub fn upsert_session(
    conn: &Connection,
    id: &str,
    agent_id: &str,
    agent_type: &str,
    project: Option<&str>,
    branch: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sessions (id, agent_id, agent_type, project, branch)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           last_event_at = datetime('now'),
           status = 'active',
           project = COALESCE(excluded.project, sessions.project),
           branch = COALESCE(excluded.branch, sessions.branch)",
        params![id, agent_id, agent_type, project, branch],
    )?;
    Ok(())
}

pub fn get_session_project_branch(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<(Option<String>, Option<String>)>> {
    let mut stmt = conn.prepare_cached("SELECT project, branch FROM sessions WHERE id = ?1")?;
    let mut rows = stmt.query(params![session_id])?;
    match rows.next()? {
        Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
        None => Ok(None),
    }
}

pub fn idle_session(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET status = 'idle', ended_at = datetime('now')
         WHERE id = ?1 AND status != 'ended'",
        params![session_id],
    )?;
    Ok(())
}

pub fn end_session(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET status = 'ended', ended_at = datetime('now')
         WHERE id = ?1",
        params![session_id],
    )?;
    Ok(())
}

pub fn update_idle_sessions(conn: &Connection, timeout_minutes: u64) -> rusqlite::Result<usize> {
    let neg = format!("-{timeout_minutes}");
    let idled = conn.execute(
        "UPDATE sessions SET status = 'idle'
         WHERE status = 'active'
         AND last_event_at < datetime('now', ?1 || ' minutes')",
        params![neg],
    )?;

    let neg_double = format!("-{}", timeout_minutes * 2);
    conn.execute(
        "UPDATE sessions SET status = 'ended', ended_at = datetime('now')
         WHERE status = 'idle' AND ended_at IS NULL
         AND last_event_at < datetime('now', ?1 || ' minutes')",
        params![neg_double],
    )?;

    Ok(idled)
}

// --- Events ---

#[derive(Debug, Clone, Serialize)]
pub struct EventRow {
    pub id: i64,
    pub event_id: Option<String>,
    pub session_id: String,
    pub agent_type: String,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub status: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub branch: Option<String>,
    pub project: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub client_timestamp: Option<String>,
    pub metadata: String,
    pub payload_truncated: i64,
    pub model: Option<String>,
    pub cost_usd: Option<f64>,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub source: String,
}

impl EventRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            event_id: row.get("event_id")?,
            session_id: row.get("session_id")?,
            agent_type: row.get("agent_type")?,
            event_type: row.get("event_type")?,
            tool_name: row.get("tool_name")?,
            status: row.get("status")?,
            tokens_in: row.get("tokens_in")?,
            tokens_out: row.get("tokens_out")?,
            branch: row.get("branch")?,
            project: row.get("project")?,
            duration_ms: row.get("duration_ms")?,
            created_at: row.get("created_at")?,
            client_timestamp: row.get("client_timestamp")?,
            metadata: row.get("metadata")?,
            payload_truncated: row.get("payload_truncated")?,
            model: row.get("model")?,
            cost_usd: row.get("cost_usd")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_write_tokens: row.get("cache_write_tokens")?,
            source: row.get("source")?,
        })
    }
}

pub struct InsertEventParams<'a> {
    pub event_id: Option<&'a str>,
    pub session_id: &'a str,
    pub agent_type: &'a str,
    pub event_type: &'a str,
    pub tool_name: Option<&'a str>,
    pub status: &'a str,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub branch: Option<&'a str>,
    pub project: Option<&'a str>,
    pub duration_ms: Option<i64>,
    pub client_timestamp: Option<&'a str>,
    pub metadata: &'a str,
    pub payload_truncated: bool,
    pub model: Option<&'a str>,
    pub cost_usd: Option<f64>,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub source: &'a str,
}

/// Insert an event. Returns the inserted row, or None if deduplicated (event_id conflict).
pub fn insert_event(
    conn: &Connection,
    p: &InsertEventParams<'_>,
) -> rusqlite::Result<Option<EventRow>> {
    let agent_id = format!("{}-default", p.agent_type);
    upsert_agent(conn, &agent_id, p.agent_type)?;
    upsert_session(
        conn,
        p.session_id,
        &agent_id,
        p.agent_type,
        p.project,
        p.branch,
    )?;

    // Handle session lifecycle
    if p.event_type == "session_end" {
        if p.agent_type == "claude_code" {
            idle_session(conn, p.session_id)?;
        } else {
            end_session(conn, p.session_id)?;
        }
    }

    let computed_cost = if p.cost_usd.is_none() && (p.tokens_in > 0 || p.tokens_out > 0) {
        p.model.and_then(|model| {
            calculate_cost(
                model,
                TokenCounts {
                    input: p.tokens_in,
                    output: p.tokens_out,
                    cache_read: p.cache_read_tokens,
                    cache_write: p.cache_write_tokens,
                },
            )
        })
    } else {
        p.cost_usd
    };

    let result = conn.execute(
        "INSERT INTO events (
            event_id, session_id, agent_type, event_type, tool_name, status,
            tokens_in, tokens_out, branch, project, duration_ms,
            created_at, client_timestamp, metadata, payload_truncated,
            model, cost_usd, cache_read_tokens, cache_write_tokens, source
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11,
            datetime('now'), ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?19
         )",
        params![
            p.event_id,
            p.session_id,
            p.agent_type,
            p.event_type,
            p.tool_name,
            p.status,
            p.tokens_in,
            p.tokens_out,
            p.branch,
            p.project,
            p.duration_ms,
            p.client_timestamp,
            p.metadata,
            p.payload_truncated as i64,
            p.model,
            computed_cost,
            p.cache_read_tokens,
            p.cache_write_tokens,
            p.source,
        ],
    );

    match result {
        Ok(0) => Ok(None), // no rows changed (shouldn't happen with INSERT, but defensive)
        Ok(_) => {
            let rowid = conn.last_insert_rowid();
            let mut stmt = conn.prepare_cached("SELECT * FROM events WHERE id = ?1")?;
            let row = stmt.query_row(params![rowid], EventRow::from_row)?;
            Ok(Some(row))
        }
        Err(e) => {
            // UNIQUE constraint violation on event_id = deduplicated
            if e.to_string()
                .contains("UNIQUE constraint failed: events.event_id")
            {
                Ok(None)
            } else {
                Err(e)
            }
        }
    }
}

// --- Stats ---

#[derive(Debug, Serialize)]
pub struct Stats {
    pub total_events: i64,
    pub active_sessions: i64,
    pub total_sessions: i64,
    pub total_tokens_in: i64,
    pub total_tokens_out: i64,
    pub total_cost_usd: f64,
}

pub fn get_stats(conn: &Connection) -> rusqlite::Result<Stats> {
    let mut stmt = conn.prepare_cached(
        "SELECT
            COUNT(*) as total_events,
            COALESCE(SUM(tokens_in), 0) as total_tokens_in,
            COALESCE(SUM(tokens_out), 0) as total_tokens_out,
            COALESCE(SUM(cost_usd), 0) as total_cost_usd
         FROM events",
    )?;
    let (total_events, total_tokens_in, total_tokens_out, total_cost_usd) =
        stmt.query_row([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?;

    let active_sessions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE status = 'active'",
        [],
        |row| row.get(0),
    )?;

    let total_sessions: i64 =
        conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;

    Ok(Stats {
        total_events,
        active_sessions,
        total_sessions,
        total_tokens_in,
        total_tokens_out,
        total_cost_usd,
    })
}

#[derive(Debug, Default, Clone)]
pub struct AnalyticsFilters {
    pub agent_type: Option<String>,
    pub since: Option<String>,
}

// --- Advanced stats endpoints ---

#[derive(Debug, Clone, Serialize)]
pub struct ToolAnalyticsRow {
    pub tool_name: String,
    pub total_calls: i64,
    pub error_count: i64,
    pub error_rate: f64,
    pub avg_duration_ms: Option<f64>,
    pub by_agent: HashMap<String, i64>,
}

pub fn get_tool_analytics(
    conn: &Connection,
    filters: &AnalyticsFilters,
) -> rusqlite::Result<Vec<ToolAnalyticsRow>> {
    let mut conditions = vec!["tool_name IS NOT NULL".to_string()];
    let mut params: Vec<SqlValue> = Vec::new();

    if let Some(agent_type) = filters.agent_type.as_deref() {
        conditions.push("agent_type = ?".to_string());
        params.push(SqlValue::Text(agent_type.to_string()));
    }
    if let Some(since) = filters.since.as_deref() {
        conditions.push("created_at >= ?".to_string());
        params.push(SqlValue::Text(since.to_string()));
    }

    let where_clause = format!("WHERE {}", conditions.join(" AND "));
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();

    let rows_sql = format!(
        "SELECT
            tool_name,
            COUNT(*) as total_calls,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
            ROUND(CAST(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) as error_rate,
            ROUND(AVG(duration_ms)) as avg_duration_ms
         FROM events
         {}
         GROUP BY tool_name
         ORDER BY total_calls DESC",
        where_clause
    );

    let mut stmt = conn.prepare(&rows_sql)?;
    let summary_rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, f64>(3)?,
            row.get::<_, Option<f64>>(4)?,
        ))
    })?;
    let summary: Vec<(String, i64, i64, f64, Option<f64>)> =
        summary_rows.collect::<Result<Vec<_>, _>>()?;

    let agent_sql = format!(
        "SELECT tool_name, agent_type, COUNT(*) as count
         FROM events
         {}
         GROUP BY tool_name, agent_type
         ORDER BY tool_name, count DESC",
        where_clause
    );
    let mut agent_stmt = conn.prepare(&agent_sql)?;
    let agent_rows = agent_stmt.query_map(params_refs.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;

    let mut by_tool: HashMap<String, HashMap<String, i64>> = HashMap::new();
    for row in agent_rows {
        let (tool_name, agent_type, count) = row?;
        by_tool
            .entry(tool_name)
            .or_default()
            .insert(agent_type, count);
    }

    Ok(summary
        .into_iter()
        .map(
            |(tool_name, total_calls, error_count, error_rate, avg_duration_ms)| ToolAnalyticsRow {
                by_agent: by_tool.remove(&tool_name).unwrap_or_default(),
                tool_name,
                total_calls,
                error_count,
                error_rate,
                avg_duration_ms,
            },
        )
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct CostBucket {
    pub bucket: String,
    pub cost_usd: f64,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub event_count: i64,
}

pub fn get_cost_over_time(
    conn: &Connection,
    filters: &AnalyticsFilters,
) -> rusqlite::Result<Vec<CostBucket>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();

    if let Some(agent_type) = filters.agent_type.as_deref() {
        conditions.push("agent_type = ?".to_string());
        params.push(SqlValue::Text(agent_type.to_string()));
    }
    if let Some(since) = filters.since.as_deref() {
        conditions.push("COALESCE(client_timestamp, created_at) >= ?".to_string());
        params.push(SqlValue::Text(since.to_string()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();

    let sql = format!(
        "SELECT
            strftime('%Y-%m-%dT%H:00:00Z', COALESCE(client_timestamp, created_at)) as bucket,
            COALESCE(SUM(cost_usd), 0) as cost_usd,
            COALESCE(SUM(tokens_in), 0) as tokens_in,
            COALESCE(SUM(tokens_out), 0) as tokens_out,
            COUNT(*) as event_count
         FROM events
         {}
         GROUP BY bucket
         ORDER BY bucket ASC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CostBucket {
            bucket: row.get(0)?,
            cost_usd: row.get(1)?,
            tokens_in: row.get(2)?,
            tokens_out: row.get(3)?,
            event_count: row.get(4)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectCostRow {
    pub project: String,
    pub cost_usd: f64,
    pub session_count: i64,
    pub event_count: i64,
}

pub fn get_cost_by_project(
    conn: &Connection,
    limit: i64,
    filters: &AnalyticsFilters,
) -> rusqlite::Result<Vec<ProjectCostRow>> {
    let mut conditions = vec!["e.cost_usd > 0".to_string()];
    let mut params: Vec<SqlValue> = Vec::new();

    if let Some(agent_type) = filters.agent_type.as_deref() {
        conditions.push("e.agent_type = ?".to_string());
        params.push(SqlValue::Text(agent_type.to_string()));
    }
    if let Some(since) = filters.since.as_deref() {
        conditions.push("e.created_at >= ?".to_string());
        params.push(SqlValue::Text(since.to_string()));
    }

    let where_clause = format!("WHERE {}", conditions.join(" AND "));
    params.push(SqlValue::Integer(limit));
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();

    let sql = format!(
        "SELECT
            COALESCE(s.project, 'unknown') as project,
            COALESCE(SUM(e.cost_usd), 0) as cost_usd,
            COUNT(DISTINCT e.session_id) as session_count,
            COUNT(*) as event_count
         FROM events e
         LEFT JOIN sessions s ON s.id = e.session_id
         {}
         GROUP BY s.project
         ORDER BY cost_usd DESC
         LIMIT ?",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(ProjectCostRow {
            project: row.get(0)?,
            cost_usd: row.get(1)?,
            session_count: row.get(2)?,
            event_count: row.get(3)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelCostRow {
    pub model: String,
    pub cost_usd: f64,
    pub event_count: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
}

pub fn get_cost_by_model(
    conn: &Connection,
    filters: &AnalyticsFilters,
) -> rusqlite::Result<Vec<ModelCostRow>> {
    let mut conditions = vec!["model IS NOT NULL".to_string(), "cost_usd > 0".to_string()];
    let mut params: Vec<SqlValue> = Vec::new();

    if let Some(agent_type) = filters.agent_type.as_deref() {
        conditions.push("agent_type = ?".to_string());
        params.push(SqlValue::Text(agent_type.to_string()));
    }
    if let Some(since) = filters.since.as_deref() {
        conditions.push("created_at >= ?".to_string());
        params.push(SqlValue::Text(since.to_string()));
    }

    let where_clause = format!("WHERE {}", conditions.join(" AND "));
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();

    let sql = format!(
        "SELECT
            model,
            COALESCE(SUM(cost_usd), 0) as cost_usd,
            COUNT(*) as event_count,
            COALESCE(SUM(tokens_in), 0) as tokens_in,
            COALESCE(SUM(tokens_out), 0) as tokens_out
         FROM events
         {}
         GROUP BY model
         ORDER BY cost_usd DESC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(ModelCostRow {
            model: row.get(0)?,
            cost_usd: row.get(1)?,
            event_count: row.get(2)?,
            tokens_in: row.get(3)?,
            tokens_out: row.get(4)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageWindow {
    pub used: f64,
    pub limit: f64,
    #[serde(rename = "windowHours")]
    pub window_hours: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUsageData {
    pub agent_type: String,
    #[serde(rename = "limitType")]
    pub limit_type: String,
    pub session: UsageWindow,
    pub extended: Option<UsageWindow>,
}

pub fn get_usage_monitor(
    conn: &Connection,
    usage_config: &UsageMonitorConfig,
) -> rusqlite::Result<Vec<AgentUsageData>> {
    let mut stmt =
        conn.prepare_cached("SELECT DISTINCT agent_type FROM events WHERE agent_type IS NOT NULL")?;
    let agent_types = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut results: Vec<AgentUsageData> = Vec::new();

    for agent_type in agent_types {
        let cfg = usage_config.for_agent(&agent_type);

        if cfg.session_limit <= 0.0 && cfg.extended_limit <= 0.0 {
            continue;
        }

        let sum_expr = match cfg.limit_type {
            crate::config::UsageLimitType::Cost => "COALESCE(SUM(cost_usd), 0)",
            crate::config::UsageLimitType::Tokens => "COALESCE(SUM(tokens_in + tokens_out), 0)",
        };

        let session_sql = format!(
            "SELECT {} as used
             FROM events
             WHERE agent_type = ?1 AND created_at >= datetime('now', ?2 || ' hours')",
            sum_expr
        );
        let session_used: f64 = conn.query_row(
            &session_sql,
            params![agent_type, format!("-{}", cfg.session_window_hours)],
            |row| row.get(0),
        )?;

        let extended = if cfg.extended_limit > 0.0 {
            let ext_sql = format!(
                "SELECT {} as used
                 FROM events
                 WHERE agent_type = ?1 AND created_at >= datetime('now', ?2 || ' hours')",
                sum_expr
            );
            let ext_used: f64 = conn.query_row(
                &ext_sql,
                params![agent_type, format!("-{}", cfg.extended_window_hours)],
                |row| row.get(0),
            )?;

            Some(UsageWindow {
                used: ext_used,
                limit: cfg.extended_limit,
                window_hours: cfg.extended_window_hours,
            })
        } else {
            None
        };

        results.push(AgentUsageData {
            limit_type: cfg.limit_type.as_str().to_string(),
            agent_type,
            session: UsageWindow {
                used: session_used,
                limit: cfg.session_limit,
                window_hours: cfg.session_window_hours,
            },
            extended,
        });
    }

    Ok(results)
}

// --- Sessions API ---

#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub agent_id: String,
    pub agent_type: String,
    pub project: Option<String>,
    pub branch: Option<String>,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_event_at: String,
    pub metadata: String,
    pub event_count: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub total_cost_usd: f64,
    pub files_edited: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

impl SessionRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            agent_id: row.get("agent_id")?,
            agent_type: row.get("agent_type")?,
            project: row.get("project")?,
            branch: row.get("branch")?,
            status: row.get("status")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            last_event_at: row.get("last_event_at")?,
            metadata: row.get("metadata")?,
            event_count: row.get("event_count")?,
            tokens_in: row.get("tokens_in")?,
            tokens_out: row.get("tokens_out")?,
            total_cost_usd: row.get("total_cost_usd")?,
            files_edited: row.get("files_edited")?,
            lines_added: row.get("lines_added")?,
            lines_removed: row.get("lines_removed")?,
        })
    }
}

#[derive(Debug, Default)]
pub struct SessionFilters {
    pub status: Option<String>,
    pub exclude_status: Option<String>,
    pub agent_type: Option<String>,
    pub since: Option<String>,
    pub limit: Option<i64>,
}

pub fn get_sessions(
    conn: &Connection,
    filters: &SessionFilters,
) -> rusqlite::Result<Vec<SessionRow>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();

    if let Some(status) = filters.status.as_deref() {
        conditions.push("s.status = ?".to_string());
        params.push(SqlValue::Text(status.to_string()));
    }
    if let Some(exclude_status) = filters.exclude_status.as_deref() {
        conditions.push("s.status != ?".to_string());
        params.push(SqlValue::Text(exclude_status.to_string()));
    }
    if let Some(agent_type) = filters.agent_type.as_deref() {
        conditions.push("s.agent_type = ?".to_string());
        params.push(SqlValue::Text(agent_type.to_string()));
    }
    if let Some(since) = filters.since.as_deref() {
        conditions.push("s.last_event_at >= ?".to_string());
        params.push(SqlValue::Text(since.to_string()));
    }

    let mut sql = String::from(
        "SELECT s.*,
            COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
            COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
            COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out,
            COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) as total_cost_usd,
            COALESCE((SELECT COUNT(DISTINCT json_extract(e.metadata, '$.file_path')) FROM events e WHERE e.session_id = s.id AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin') AND json_extract(e.metadata, '$.file_path') IS NOT NULL), 0) as files_edited,
            COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_added') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_extract(e.metadata, '$.lines_added') IS NOT NULL), 0) as lines_added,
            COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_removed') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_extract(e.metadata, '$.lines_removed') IS NOT NULL), 0) as lines_removed
         FROM sessions s",
    );

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    sql.push_str(
        " ORDER BY
            CASE s.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
            s.last_event_at DESC
          LIMIT ?",
    );

    let limit = filters.limit.unwrap_or(50);
    params.push(SqlValue::Integer(limit));

    let params_refs: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_refs.as_slice(), SessionRow::from_row)?;
    rows.collect()
}

pub fn get_session_with_events(
    conn: &Connection,
    session_id: &str,
    event_limit: i64,
) -> rusqlite::Result<(Option<SessionRow>, Vec<EventRow>)> {
    let mut session_stmt = conn.prepare_cached(
        "SELECT s.*,
            COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
            COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
            COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out,
            COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) as total_cost_usd,
            COALESCE((SELECT COUNT(DISTINCT json_extract(e.metadata, '$.file_path')) FROM events e WHERE e.session_id = s.id AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin') AND json_extract(e.metadata, '$.file_path') IS NOT NULL), 0) as files_edited,
            COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_added') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_extract(e.metadata, '$.lines_added') IS NOT NULL), 0) as lines_added,
            COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_removed') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_extract(e.metadata, '$.lines_removed') IS NOT NULL), 0) as lines_removed
         FROM sessions s
         WHERE s.id = ?1",
    )?;

    let session = match session_stmt.query_row(params![session_id], SessionRow::from_row) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e),
    };

    let mut event_stmt = conn.prepare_cached(
        "SELECT * FROM events WHERE session_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let event_rows = event_stmt.query_map(params![session_id, event_limit], EventRow::from_row)?;
    let events: Vec<EventRow> = event_rows.collect::<Result<Vec<_>, _>>()?;

    Ok((session, events))
}

// --- Filter options ---

#[derive(Debug, Clone, Serialize)]
pub struct BranchOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterOptions {
    pub agent_types: Vec<String>,
    pub event_types: Vec<String>,
    pub tool_names: Vec<String>,
    pub models: Vec<String>,
    pub projects: Vec<String>,
    pub branches: Vec<BranchOption>,
    pub sources: Vec<String>,
}

pub fn get_filter_options(conn: &Connection) -> rusqlite::Result<FilterOptions> {
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT agent_type FROM events WHERE agent_type IS NOT NULL ORDER BY agent_type",
    )?;
    let agent_types = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT event_type FROM events WHERE event_type IS NOT NULL ORDER BY event_type",
    )?;
    let event_types = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT tool_name FROM events WHERE tool_name IS NOT NULL ORDER BY tool_name",
    )?;
    let tool_names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT model FROM events WHERE model IS NOT NULL ORDER BY model",
    )?;
    let models = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL ORDER BY project",
    )?;
    let projects = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare_cached(
        "SELECT branch, project, MAX(last_event_at) as latest
         FROM sessions
         WHERE branch IS NOT NULL AND branch != 'HEAD'
         GROUP BY branch
         ORDER BY latest DESC",
    )?;
    let branch_rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut branches: Vec<BranchOption> = Vec::new();
    for row in branch_rows {
        let (branch, project) = row?;
        let label = match project {
            Some(project_name) => format!("{project_name} / {branch}"),
            None => branch.clone(),
        };
        branches.push(BranchOption {
            value: branch,
            label,
        });
    }

    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT source FROM events WHERE source IS NOT NULL ORDER BY source",
    )?;
    let sources = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(FilterOptions {
        agent_types,
        event_types,
        tool_names,
        models,
        projects,
        branches,
        sources,
    })
}

// --- Session transcript ---

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptEvent {
    pub id: i64,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub status: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub model: Option<String>,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub client_timestamp: Option<String>,
    pub metadata: String,
}

pub fn get_session_transcript(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<TranscriptEvent>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, event_type, tool_name, status, tokens_in, tokens_out,
                model, cost_usd, duration_ms, created_at, client_timestamp, metadata
         FROM events
         WHERE session_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;

    let rows = stmt.query_map(
        params_from_iter([SqlValue::Text(session_id.to_string())]),
        |row| {
            Ok(TranscriptEvent {
                id: row.get("id")?,
                event_type: row.get("event_type")?,
                tool_name: row.get("tool_name")?,
                status: row.get("status")?,
                tokens_in: row.get("tokens_in")?,
                tokens_out: row.get("tokens_out")?,
                model: row.get("model")?,
                cost_usd: row.get("cost_usd")?,
                duration_ms: row.get("duration_ms")?,
                created_at: row.get("created_at")?,
                client_timestamp: row.get("client_timestamp")?,
                metadata: row.get("metadata")?,
            })
        },
    )?;

    rows.collect()
}
