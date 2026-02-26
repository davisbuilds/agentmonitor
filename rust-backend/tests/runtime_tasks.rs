use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::Value;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::db::queries::{self, InsertEventParams};
use agentmonitor_rs::runtime_tasks::{run_idle_check_once, run_stats_broadcast_once};
use agentmonitor_rs::state::AppState;

fn test_state() -> Arc<AppState> {
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let config = Config::from_env();
    AppState::new(conn, config)
}

fn parse_sse_message(raw: &str) -> Value {
    let content = raw
        .strip_prefix("data: ")
        .and_then(|s| s.strip_suffix("\n\n"))
        .unwrap_or(raw);
    serde_json::from_str(content).expect("valid json payload")
}

#[tokio::test]
async fn stats_broadcast_emits_stats_payload_when_clients_connected() {
    let state = test_state();
    {
        let db = state.db.lock().await;
        let params = InsertEventParams {
            event_id: Some("stats-event-1"),
            session_id: "stats-sess-1",
            agent_type: "codex",
            event_type: "llm_response",
            tool_name: None,
            status: "success",
            tokens_in: 100,
            tokens_out: 50,
            branch: None,
            project: None,
            duration_ms: None,
            client_timestamp: None,
            metadata: "{}",
            payload_truncated: false,
            model: Some("o3"),
            cost_usd: Some(1.25),
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            source: "api",
        };
        let _ = queries::insert_event(&db, &params).expect("insert event");
    }

    let client = state.sse_hub.subscribe().expect("expected SSE client slot");
    let (mut rx, _guard) = client.into_parts();

    let sent = run_stats_broadcast_once(Arc::clone(&state)).await;
    assert!(sent);

    let raw = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("expected message in timeout")
        .expect("recv failed");
    let msg = parse_sse_message(&raw);
    assert_eq!(msg["type"], "stats");
    assert!(msg["payload"]["total_events"].as_i64().unwrap_or(0) >= 1);
    assert!(msg["payload"]["usage_monitor"].is_array());
}

#[tokio::test]
async fn stats_broadcast_skips_when_no_clients_connected() {
    let state = test_state();
    let sent = run_stats_broadcast_once(Arc::clone(&state)).await;
    assert!(!sent);
}

#[tokio::test]
async fn idle_check_broadcasts_session_update_when_sessions_idled() {
    let state = test_state();
    {
        let db = state.db.lock().await;
        db.execute(
            "INSERT INTO agents (id, agent_type) VALUES (?1, ?2)",
            params!["claude_code-default", "claude_code"],
        )
        .expect("insert agent");
        db.execute(
            "INSERT INTO sessions (id, agent_id, agent_type, status, last_event_at)
             VALUES (?1, ?2, ?3, 'active', datetime('now', '-10 minutes'))",
            params!["idle-sess", "claude_code-default", "claude_code"],
        )
        .expect("insert session");
    }

    let client = state.sse_hub.subscribe().expect("expected SSE client slot");
    let (mut rx, _guard) = client.into_parts();

    let idled = run_idle_check_once(Arc::clone(&state)).await;
    assert_eq!(idled, 1);

    let raw = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("expected message in timeout")
        .expect("recv failed");
    let msg = parse_sse_message(&raw);
    assert_eq!(msg["type"], "session_update");
    assert_eq!(msg["payload"]["type"], "idle_check");
    assert_eq!(msg["payload"]["idled"], 1);
}
