use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::Connection;

fn init_db() -> Connection {
    let _path = PathBuf::from(":memory:");
    // Can't use initialize with :memory: since it takes a Path, so replicate inline
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "busy_timeout", 5000).unwrap();

    // Load schema from the actual module via file-based init
    // For in-memory, we execute the schema SQL directly
    let schema_sql = include_str!("../src/db/schema.rs");
    // Extract the SQL between r#" and "#
    let start = schema_sql.find("r#\"\n").unwrap() + 4;
    let end = schema_sql.rfind("\"#;").unwrap();
    let sql = &schema_sql[start..end];
    conn.execute_batch(sql).unwrap();
    conn
}

fn get_table_names(conn: &Connection) -> HashSet<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

fn get_column_names(conn: &Connection, table: &str) -> HashSet<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(1)).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

fn get_index_names(conn: &Connection) -> HashSet<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

#[test]
fn required_tables_exist() {
    let conn = init_db();
    let tables = get_table_names(&conn);
    for required in ["agents", "sessions", "events", "import_state"] {
        assert!(
            tables.contains(required),
            "Missing required table: {required}"
        );
    }
}

#[test]
fn import_state_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "import_state");
    let expected: HashSet<String> = [
        "file_path",
        "file_hash",
        "file_size",
        "source",
        "events_imported",
        "imported_at",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(cols, expected, "import_state columns mismatch");
}

#[test]
fn agents_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "agents");
    let expected: HashSet<String> = ["id", "agent_type", "name", "registered_at", "last_seen_at"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(cols, expected, "agents columns mismatch");
}

#[test]
fn sessions_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "sessions");
    let expected: HashSet<String> = [
        "id",
        "agent_id",
        "agent_type",
        "project",
        "branch",
        "status",
        "started_at",
        "ended_at",
        "last_event_at",
        "metadata",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(cols, expected, "sessions columns mismatch");
}

#[test]
fn events_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "events");
    let expected: HashSet<String> = [
        "id",
        "event_id",
        "schema_version",
        "session_id",
        "agent_type",
        "event_type",
        "tool_name",
        "status",
        "tokens_in",
        "tokens_out",
        "branch",
        "project",
        "duration_ms",
        "created_at",
        "client_timestamp",
        "metadata",
        "payload_truncated",
        "model",
        "cost_usd",
        "cache_read_tokens",
        "cache_write_tokens",
        "source",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(cols, expected, "events columns mismatch");
}

#[test]
fn required_indexes_exist() {
    let conn = init_db();
    let indexes = get_index_names(&conn);
    let required = [
        "idx_events_created_at",
        "idx_events_session_id",
        "idx_events_event_type",
        "idx_events_tool_name",
        "idx_events_agent_type",
        "idx_events_model",
        "idx_sessions_status",
    ];
    for idx in required {
        assert!(indexes.contains(idx), "Missing required index: {idx}");
    }
}

#[test]
fn event_id_unique_constraint_enforced() {
    let conn = init_db();
    conn.execute(
        "INSERT INTO events (event_id, session_id, agent_type, event_type, status)
         VALUES ('evt-1', 'sess-1', 'claude_code', 'tool_use', 'success')",
        [],
    )
    .unwrap();

    let result = conn.execute(
        "INSERT INTO events (event_id, session_id, agent_type, event_type, status)
         VALUES ('evt-1', 'sess-2', 'claude_code', 'tool_use', 'success')",
        [],
    );
    assert!(result.is_err(), "Duplicate event_id should be rejected");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("UNIQUE constraint failed"),
        "Error should be a UNIQUE constraint violation"
    );
}

#[test]
fn status_check_constraint_enforced() {
    let conn = init_db();
    let result = conn.execute(
        "INSERT INTO events (session_id, agent_type, event_type, status)
         VALUES ('sess-1', 'claude_code', 'tool_use', 'invalid_status')",
        [],
    );
    assert!(
        result.is_err(),
        "Invalid status should be rejected by CHECK constraint"
    );
}

#[test]
fn payload_truncated_check_constraint_enforced() {
    let conn = init_db();
    let result = conn.execute(
        "INSERT INTO events (session_id, agent_type, event_type, status, payload_truncated)
         VALUES ('sess-1', 'claude_code', 'tool_use', 'success', 2)",
        [],
    );
    assert!(result.is_err(), "payload_truncated must be 0 or 1");
}

#[test]
fn default_values_match_typescript() {
    let conn = init_db();
    conn.execute(
        "INSERT INTO events (session_id, agent_type, event_type)
         VALUES ('sess-1', 'claude_code', 'tool_use')",
        [],
    )
    .unwrap();

    let (status, tokens_in, tokens_out, payload_truncated, source, schema_version): (
        String,
        i64,
        i64,
        i64,
        String,
        i64,
    ) = conn
        .query_row(
            "SELECT status, tokens_in, tokens_out, payload_truncated, source, schema_version
             FROM events WHERE session_id = 'sess-1'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();

    assert_eq!(status, "success");
    assert_eq!(tokens_in, 0);
    assert_eq!(tokens_out, 0);
    assert_eq!(payload_truncated, 0);
    assert_eq!(source, "api");
    assert_eq!(schema_version, 1);
}
