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
"#;
