use std::collections::HashSet;
use std::path::Path;

use agentmonitor_rs::db;
use rusqlite::Connection;

fn init_db() -> Connection {
    db::initialize(Path::new(":memory:")).unwrap()
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
    for required in [
        "agents",
        "sessions",
        "events",
        "import_state",
        "browsing_sessions",
        "messages",
        "pinned_messages",
        "insights",
        "tool_calls",
        "session_turns",
        "session_items",
        "messages_fts",
        "watched_files",
    ] {
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
        "idx_bs_ended_at",
        "idx_bs_project",
        "idx_bs_agent",
        "idx_bs_started_at",
        "idx_bs_last_item_at",
        "idx_bs_live_status",
        "idx_messages_session_ordinal",
        "idx_messages_session_role",
        "idx_pm_session_ordinal",
        "idx_pm_created_at",
        "idx_insights_created_at",
        "idx_insights_scope",
        "idx_tc_session_id",
        "idx_tc_category",
        "idx_tc_tool_name",
        "idx_st_session_started_at",
        "idx_st_source_turn_id",
        "idx_si_session_created_at",
        "idx_si_turn_ordinal",
        "idx_si_source_item_id",
    ];
    for idx in required {
        assert!(indexes.contains(idx), "Missing required index: {idx}");
    }
}

#[test]
fn browsing_sessions_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "browsing_sessions");
    let expected: HashSet<String> = [
        "id",
        "project",
        "agent",
        "first_message",
        "started_at",
        "ended_at",
        "message_count",
        "user_message_count",
        "parent_session_id",
        "relationship_type",
        "live_status",
        "last_item_at",
        "integration_mode",
        "fidelity",
        "capabilities_json",
        "file_path",
        "file_size",
        "file_hash",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(cols, expected, "browsing_sessions columns mismatch");
}

#[test]
fn pinned_messages_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "pinned_messages");
    let expected: HashSet<String> = [
        "id",
        "session_id",
        "message_id",
        "message_ordinal",
        "created_at",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(cols, expected, "pinned_messages columns mismatch");
}

#[test]
fn insights_columns_match_typescript() {
    let conn = init_db();
    let cols = get_column_names(&conn, "insights");
    let expected: HashSet<String> = [
        "id",
        "kind",
        "title",
        "prompt",
        "content",
        "date_from",
        "date_to",
        "project",
        "agent",
        "provider",
        "model",
        "analytics_summary_json",
        "analytics_coverage_json",
        "usage_summary_json",
        "usage_coverage_json",
        "input_json",
        "created_at",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(cols, expected, "insights columns mismatch");
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

#[test]
fn pinned_messages_unique_session_ordinal_constraint_enforced() {
    let conn = init_db();
    conn.execute(
        "INSERT INTO pinned_messages (session_id, message_id, message_ordinal)
         VALUES ('sess-1', 1, 4)",
        [],
    )
    .unwrap();

    let result = conn.execute(
        "INSERT INTO pinned_messages (session_id, message_id, message_ordinal)
         VALUES ('sess-1', 2, 4)",
        [],
    );
    assert!(result.is_err(), "Duplicate pin ordinal should be rejected");
}
