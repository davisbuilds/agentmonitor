use std::path::Path;

use agentmonitor_rs::db;
use rusqlite::Connection;

fn init_db() -> Connection {
    db::initialize(Path::new(":memory:")).unwrap()
}

fn insert_event(conn: &Connection, event_id: &str, agent: &str, model: &str, tokens_in: i64, cache_read: i64, cost: f64) {
    conn.execute(
        "INSERT INTO events (event_id, session_id, agent_type, event_type, status,
            tokens_in, tokens_out, model, cost_usd, cache_read_tokens, cache_write_tokens, source)
         VALUES (?1, 'sess', ?2, 'llm_response', 'success', ?3, 0, ?4, ?5, ?6, 0, 'import')",
        rusqlite::params![event_id, agent, tokens_in, model, cost, cache_read],
    )
    .unwrap();
}

fn read_event(conn: &Connection, event_id: &str) -> (i64, f64) {
    conn.query_row(
        "SELECT tokens_in, cost_usd FROM events WHERE event_id = ?1",
        [event_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
fn backfill_nets_openai_rows_and_leaves_anthropic_untouched() {
    let conn = init_db();

    // Seed pre-fix (cache-inclusive) rows. gpt-5.4: 100k inclusive input, 40k cached.
    insert_event(&conn, "openai-old", "codex", "gpt-5.4", 100_000, 40_000, 1.01);
    // Anthropic input_tokens is already net and must not change.
    insert_event(&conn, "anthropic-net", "claude_code", "claude-opus-4-8", 1500, 800, 0.0079);

    // initialize() already ran the migration on the empty DB; reset the guard so
    // it re-runs over the seeded rows.
    conn.pragma_update(None, "user_version", 0).unwrap();
    db::run_data_migrations(&conn).unwrap();

    let (openai_in, openai_cost) = read_event(&conn, "openai-old");
    assert_eq!(openai_in, 60_000); // 100k - 40k cached
    // 60k*$2.5 + 40k*$0.25 per MTok = 0.15 + 0.01 = 0.16
    assert!((openai_cost - 0.16).abs() < 1e-4, "cost was {openai_cost}");

    let (anthropic_in, anthropic_cost) = read_event(&conn, "anthropic-net");
    assert_eq!(anthropic_in, 1500);
    assert!((anthropic_cost - 0.0079).abs() < 1e-9);

    // Version guard makes it run exactly once: re-running without resetting the
    // counter must not subtract the already-netted cached tokens again.
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    db::run_data_migrations(&conn).unwrap();
    let (openai_in_again, _) = read_event(&conn, "openai-old");
    assert_eq!(openai_in_again, 60_000);
}
