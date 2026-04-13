use std::fs;
use std::path::Path;

use rusqlite::{Connection, Result};

/// Open (or create) the SQLite database and apply the base schema.
/// Mirrors the TypeScript schema in src/db/schema.ts exactly for spike-scoped tables.
pub fn initialize(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path)?;

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;

    conn.execute_batch(SCHEMA_SQL)?;
    apply_post_schema_migrations(&conn)?;

    Ok(conn)
}

/// Exact mirror of TypeScript schema from src/db/schema.ts.
/// Column names, types, defaults, and constraints match 1:1.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    name TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    project TEXT,
    branch TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    schema_version INTEGER NOT NULL DEFAULT 1,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    branch TEXT,
    project TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    client_timestamp TEXT,
    metadata TEXT DEFAULT '{}',
    payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
    model TEXT,
    cost_usd REAL,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    source TEXT DEFAULT 'api'
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_type);
CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS import_state (
    file_path TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    source TEXT NOT NULL,
    events_imported INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS browsing_sessions (
    id TEXT PRIMARY KEY,
    project TEXT,
    agent TEXT NOT NULL,
    first_message TEXT,
    started_at TEXT,
    ended_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    user_message_count INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    relationship_type TEXT,
    live_status TEXT,
    last_item_at TEXT,
    integration_mode TEXT,
    fidelity TEXT,
    capabilities_json TEXT,
    file_path TEXT,
    file_size INTEGER,
    file_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_bs_ended_at ON browsing_sessions(ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_bs_project ON browsing_sessions(project);
CREATE INDEX IF NOT EXISTS idx_bs_agent ON browsing_sessions(agent);
CREATE INDEX IF NOT EXISTS idx_bs_started_at ON browsing_sessions(started_at);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT,
    has_thinking INTEGER NOT NULL DEFAULT 0,
    has_tool_use INTEGER NOT NULL DEFAULT 0,
    content_length INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);

CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    category TEXT,
    tool_use_id TEXT,
    input_json TEXT,
    result_content TEXT,
    result_content_length INTEGER,
    subagent_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tc_session_id ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tc_category ON tool_calls(category);
CREATE INDEX IF NOT EXISTS idx_tc_tool_name ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS session_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    source_turn_id TEXT,
    status TEXT,
    title TEXT,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_st_session_started_at ON session_turns(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_st_source_turn_id ON session_turns(source_turn_id);

CREATE TABLE IF NOT EXISTS session_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id INTEGER,
    ordinal INTEGER NOT NULL DEFAULT 0,
    source_item_id TEXT,
    kind TEXT NOT NULL,
    status TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT,
    FOREIGN KEY(turn_id) REFERENCES session_turns(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_si_session_created_at ON session_items(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_si_turn_ordinal ON session_items(turn_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_si_source_item_id ON session_items(source_item_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS watched_files (
    file_path TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL,
    file_mtime TEXT,
    status TEXT NOT NULL DEFAULT 'parsed',
    last_parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

fn apply_post_schema_migrations(conn: &Connection) -> Result<()> {
    ensure_column(conn, "browsing_sessions", "live_status", "TEXT")?;
    ensure_column(conn, "browsing_sessions", "last_item_at", "TEXT")?;
    ensure_column(conn, "browsing_sessions", "integration_mode", "TEXT")?;
    ensure_column(conn, "browsing_sessions", "fidelity", "TEXT")?;
    ensure_column(conn, "browsing_sessions", "capabilities_json", "TEXT")?;

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_bs_last_item_at ON browsing_sessions(last_item_at DESC);
        CREATE INDEX IF NOT EXISTS idx_bs_live_status ON browsing_sessions(live_status);
        ",
    )?;

    if fts_rebuild_needed(conn)? {
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')", [])?;
    }

    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&pragma)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let existing: String = row.get(1)?;
        if existing == column {
            return Ok(());
        }
    }

    let alter_sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    conn.execute(&alter_sql, [])?;
    Ok(())
}

fn fts_rebuild_needed(conn: &Connection) -> Result<bool> {
    let messages_count: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
    if messages_count == 0 {
        return Ok(false);
    }

    let fts_count: i64 = conn.query_row("SELECT COUNT(*) FROM messages_fts", [], |row| row.get(0))?;
    Ok(fts_count == 0)
}
