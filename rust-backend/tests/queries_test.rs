use rusqlite::Connection;

// We can't import from the binary crate directly in integration tests,
// so we replicate the schema init and test the SQL behavior.

fn init_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "busy_timeout", 5000).unwrap();
    let schema_sql = include_str!("../src/db/schema.rs");
    let start = schema_sql.find("r#\"\n").unwrap() + 4;
    let end = schema_sql.rfind("\"#;").unwrap();
    conn.execute_batch(&schema_sql[start..end]).unwrap();
    conn
}

fn insert_test_event(conn: &Connection, event_id: Option<&str>, session_id: &str, agent_type: &str, event_type: &str) {
    // Upsert agent
    let agent_id = format!("{agent_type}-default");
    conn.execute(
        "INSERT INTO agents (id, agent_type) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')",
        rusqlite::params![agent_id, agent_type],
    ).unwrap();

    // Upsert session
    conn.execute(
        "INSERT INTO sessions (id, agent_id, agent_type)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET last_event_at = datetime('now'), status = 'active'",
        rusqlite::params![session_id, agent_id, agent_type],
    ).unwrap();

    // Insert event
    conn.execute(
        "INSERT INTO events (event_id, session_id, agent_type, event_type, status, source)
         VALUES (?1, ?2, ?3, ?4, 'success', 'api')",
        rusqlite::params![event_id, session_id, agent_type, event_type],
    ).unwrap();
}

#[test]
fn insert_and_retrieve_event() {
    let conn = init_db();
    insert_test_event(&conn, Some("evt-1"), "sess-1", "claude_code", "tool_use");

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);

    let event_id: String = conn.query_row(
        "SELECT event_id FROM events WHERE id = 1", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(event_id, "evt-1");
}

#[test]
fn dedup_by_event_id() {
    let conn = init_db();
    insert_test_event(&conn, Some("evt-dup"), "sess-1", "claude_code", "tool_use");

    // Second insert with same event_id should fail
    let result = conn.execute(
        "INSERT INTO events (event_id, session_id, agent_type, event_type, status, source)
         VALUES ('evt-dup', 'sess-1', 'claude_code', 'tool_use', 'success', 'api')",
        [],
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("UNIQUE constraint failed: events.event_id"));

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1, "Duplicate should not be inserted");
}

#[test]
fn null_event_id_allows_multiple_inserts() {
    let conn = init_db();
    insert_test_event(&conn, None, "sess-1", "claude_code", "tool_use");
    insert_test_event(&conn, None, "sess-1", "claude_code", "tool_use");

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2, "Null event_ids should not conflict");
}

#[test]
fn session_upsert_reactivates_on_new_event() {
    let conn = init_db();
    insert_test_event(&conn, Some("evt-1"), "sess-1", "claude_code", "tool_use");

    // Idle the session
    conn.execute(
        "UPDATE sessions SET status = 'idle' WHERE id = 'sess-1'",
        [],
    ).unwrap();

    let status: String = conn.query_row(
        "SELECT status FROM sessions WHERE id = 'sess-1'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(status, "idle");

    // New event upserts session back to active
    insert_test_event(&conn, Some("evt-2"), "sess-1", "claude_code", "tool_use");

    let status: String = conn.query_row(
        "SELECT status FROM sessions WHERE id = 'sess-1'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(status, "active");
}

#[test]
fn stats_aggregation() {
    let conn = init_db();

    // Insert events with token counts
    let agent_id = "claude_code-default";
    conn.execute(
        "INSERT INTO agents (id, agent_type) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')",
        rusqlite::params![agent_id, "claude_code"],
    ).unwrap();
    conn.execute(
        "INSERT INTO sessions (id, agent_id, agent_type) VALUES ('sess-1', ?1, 'claude_code')",
        rusqlite::params![agent_id],
    ).unwrap();

    conn.execute(
        "INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, source)
         VALUES ('sess-1', 'claude_code', 'tool_use', 'success', 100, 50, 0.01, 'api')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, source)
         VALUES ('sess-1', 'claude_code', 'tool_use', 'success', 200, 100, 0.02, 'api')",
        [],
    ).unwrap();

    let (total_events, total_tokens_in, total_tokens_out, total_cost): (i64, i64, i64, f64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(tokens_in), 0), COALESCE(SUM(tokens_out), 0), COALESCE(SUM(cost_usd), 0) FROM events",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();

    assert_eq!(total_events, 2);
    assert_eq!(total_tokens_in, 300);
    assert_eq!(total_tokens_out, 150);
    assert!((total_cost - 0.03).abs() < 1e-10);

    let active: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE status = 'active'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(active, 1);
}

#[test]
fn idle_and_end_session_lifecycle() {
    let conn = init_db();
    insert_test_event(&conn, Some("evt-1"), "sess-1", "claude_code", "tool_use");

    // Idle the session (mimics session_end for claude_code)
    conn.execute(
        "UPDATE sessions SET status = 'idle', ended_at = datetime('now')
         WHERE id = 'sess-1' AND status != 'ended'",
        [],
    ).unwrap();

    let status: String = conn.query_row(
        "SELECT status FROM sessions WHERE id = 'sess-1'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(status, "idle");

    // End the session
    conn.execute(
        "UPDATE sessions SET status = 'ended', ended_at = datetime('now') WHERE id = 'sess-1'",
        [],
    ).unwrap();

    let status: String = conn.query_row(
        "SELECT status FROM sessions WHERE id = 'sess-1'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(status, "ended");
}
