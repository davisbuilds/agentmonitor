use rusqlite::{Connection, params};
use serde::Serialize;

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
    let mut stmt = conn.prepare_cached(
        "SELECT project, branch FROM sessions WHERE id = ?1",
    )?;
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
pub fn insert_event(conn: &Connection, p: &InsertEventParams<'_>) -> rusqlite::Result<Option<EventRow>> {
    let agent_id = format!("{}-default", p.agent_type);
    upsert_agent(conn, &agent_id, p.agent_type)?;
    upsert_session(conn, p.session_id, &agent_id, p.agent_type, p.project, p.branch)?;

    // Handle session lifecycle
    if p.event_type == "session_end" {
        if p.agent_type == "claude_code" {
            idle_session(conn, p.session_id)?;
        } else {
            end_session(conn, p.session_id)?;
        }
    }

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
            p.cost_usd,
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
            if e.to_string().contains("UNIQUE constraint failed: events.event_id") {
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

    let total_sessions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions",
        [],
        |row| row.get(0),
    )?;

    Ok(Stats {
        total_events,
        active_sessions,
        total_sessions,
        total_tokens_in,
        total_tokens_out,
        total_cost_usd,
    })
}
