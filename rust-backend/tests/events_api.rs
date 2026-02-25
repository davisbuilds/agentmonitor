use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use serde_json::{json, Value};
use tower::ServiceExt;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::state::AppState;

/// Build a test app with an in-memory SQLite database.
fn test_app() -> axum::Router {
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let config = Config::from_env();
    let state: Arc<AppState> = AppState::new(conn, config);
    agentmonitor_rs::build_router(state)
}

/// Helper: send a POST request with JSON body, return (status_code, parsed body).
async fn post_json(app: &axum::Router, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    (status, parsed)
}

fn valid_event() -> Value {
    json!({
        "session_id": "sess-1",
        "agent_type": "claude_code",
        "event_type": "tool_use",
        "tool_name": "Read"
    })
}

// --- Single event ingest ---

#[tokio::test]
async fn single_valid_event_returns_201() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/events", valid_event()).await;
    assert_eq!(status, 201);
    assert_eq!(body["received"], 1);
    assert_eq!(body["duplicates"], 0);
    assert!(body["ids"].as_array().unwrap().len() == 1);
}

#[tokio::test]
async fn single_invalid_event_returns_400() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/events", json!({"session_id": "s"})).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "Invalid event payload");
    assert!(body["details"].as_array().unwrap().len() >= 1);
}

#[tokio::test]
async fn single_non_object_body_returns_400() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/events", json!("string")).await;
    assert_eq!(status, 400);
    assert!(body["details"].as_array().unwrap().iter().any(|e| {
        e["field"] == "body"
    }));
}

#[tokio::test]
async fn dedup_by_event_id_returns_200() {
    let app = test_app();
    let evt = json!({
        "event_id": "dedup-test-1",
        "session_id": "sess-1",
        "agent_type": "claude_code",
        "event_type": "tool_use"
    });

    let (status1, body1) = post_json(&app, "/api/events", evt.clone()).await;
    assert_eq!(status1, 201);
    assert_eq!(body1["received"], 1);

    let (status2, body2) = post_json(&app, "/api/events", evt).await;
    assert_eq!(status2, 200);
    assert_eq!(body2["received"], 0);
    assert_eq!(body2["duplicates"], 1);
    assert!(body2["ids"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn null_event_id_does_not_dedup() {
    let app = test_app();
    let evt = valid_event();

    let (s1, b1) = post_json(&app, "/api/events", evt.clone()).await;
    assert_eq!(s1, 201);
    let (s2, b2) = post_json(&app, "/api/events", evt).await;
    assert_eq!(s2, 201);

    // Both should be new inserts with different IDs
    assert_ne!(b1["ids"][0], b2["ids"][0]);
}

// --- Batch ingest ---

#[tokio::test]
async fn batch_valid_events_returns_201() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/events/batch", json!({
        "events": [
            {"session_id": "s1", "agent_type": "claude_code", "event_type": "tool_use"},
            {"session_id": "s2", "agent_type": "codex", "event_type": "llm_request"}
        ]
    })).await;

    assert_eq!(status, 201);
    assert_eq!(body["received"], 2);
    assert_eq!(body["duplicates"], 0);
    assert!(body["rejected"].as_array().unwrap().is_empty());
    assert_eq!(body["ids"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn batch_missing_events_key_returns_400() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/events/batch", json!({"data": []})).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "Expected { events: [...] }");
}

#[tokio::test]
async fn batch_partial_rejection() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/events/batch", json!({
        "events": [
            {"session_id": "s1", "agent_type": "claude_code", "event_type": "tool_use"},
            {"session_id": "bad-event"},
            {"session_id": "s2", "agent_type": "codex", "event_type": "llm_response"}
        ]
    })).await;

    assert_eq!(status, 201);
    assert_eq!(body["received"], 2);
    assert_eq!(body["duplicates"], 0);

    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["index"], 1);
    assert!(!rejected[0]["errors"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn batch_dedup_counted_separately() {
    let app = test_app();

    // Insert first
    post_json(&app, "/api/events", json!({
        "event_id": "batch-dup-1",
        "session_id": "s1",
        "agent_type": "claude_code",
        "event_type": "tool_use"
    })).await;

    // Batch with one new, one duplicate, one invalid
    let (status, body) = post_json(&app, "/api/events/batch", json!({
        "events": [
            {"session_id": "s2", "agent_type": "codex", "event_type": "llm_request"},
            {"event_id": "batch-dup-1", "session_id": "s1", "agent_type": "claude_code", "event_type": "tool_use"},
            {"bogus": true}
        ]
    })).await;

    assert_eq!(status, 201);
    assert_eq!(body["received"], 1);
    assert_eq!(body["duplicates"], 1);
    assert_eq!(body["rejected"].as_array().unwrap().len(), 1);
}

// --- Session lifecycle ---

#[tokio::test]
async fn session_end_transitions_claude_code_to_idle() {
    let app = test_app();

    // Start a session with a regular event
    post_json(&app, "/api/events", json!({
        "session_id": "lifecycle-sess",
        "agent_type": "claude_code",
        "event_type": "tool_use"
    })).await;

    // Send session_end — for claude_code this should idle, not end
    post_json(&app, "/api/events", json!({
        "session_id": "lifecycle-sess",
        "agent_type": "claude_code",
        "event_type": "session_end"
    })).await;

    // Send another event — session should reactivate (upsert sets status='active')
    let (status, body) = post_json(&app, "/api/events", json!({
        "session_id": "lifecycle-sess",
        "agent_type": "claude_code",
        "event_type": "tool_use"
    })).await;

    assert_eq!(status, 201);
    assert_eq!(body["received"], 1);
}

#[tokio::test]
async fn session_end_transitions_non_claude_code_to_ended() {
    let app = test_app();

    post_json(&app, "/api/events", json!({
        "session_id": "codex-sess",
        "agent_type": "codex",
        "event_type": "tool_use"
    })).await;

    // session_end for non-claude_code goes directly to ended
    post_json(&app, "/api/events", json!({
        "session_id": "codex-sess",
        "agent_type": "codex",
        "event_type": "session_end"
    })).await;

    // New event reactivates
    let (status, body) = post_json(&app, "/api/events", json!({
        "session_id": "codex-sess",
        "agent_type": "codex",
        "event_type": "tool_use"
    })).await;

    assert_eq!(status, 201);
    assert_eq!(body["received"], 1);
}

// --- Metadata truncation ---

#[tokio::test]
async fn oversized_metadata_gets_truncated() {
    let app = test_app();

    // Default max_payload_kb is 10 (10240 bytes). Create metadata larger than that.
    let big = "x".repeat(20_000);
    let (status, body) = post_json(&app, "/api/events", json!({
        "session_id": "meta-sess",
        "agent_type": "claude_code",
        "event_type": "tool_use",
        "metadata": {"big_field": big, "command": "important-cmd"}
    })).await;

    assert_eq!(status, 201);
    assert_eq!(body["received"], 1);
}

// --- Rejection error format ---

#[tokio::test]
async fn batch_rejection_errors_use_field_colon_message_format() {
    let app = test_app();
    let (_, body) = post_json(&app, "/api/events/batch", json!({
        "events": [
            {"session_id": 123, "agent_type": true, "event_type": 456}
        ]
    })).await;

    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected[0]["index"], 0);
    let errors = rejected[0]["errors"].as_array().unwrap();
    // Each error should be "field: message" format matching TypeScript
    for err in errors {
        let s = err.as_str().unwrap();
        assert!(s.contains(": "), "expected 'field: message' format, got: {s}");
    }
}
