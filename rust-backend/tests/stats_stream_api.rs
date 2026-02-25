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

fn test_app() -> axum::Router {
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let config = Config::from_env();
    let state: Arc<AppState> = AppState::new(conn, config);
    agentmonitor_rs::build_router(state)
}

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

async fn get_json(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    (status, parsed)
}

// ==================== GET /api/stats ====================

#[tokio::test]
async fn stats_empty_db_returns_zeros() {
    let app = test_app();
    let (status, body) = get_json(&app, "/api/stats").await;
    assert_eq!(status, 200);
    assert_eq!(body["total_events"], 0);
    assert_eq!(body["active_sessions"], 0);
    assert_eq!(body["total_sessions"], 0);
    assert_eq!(body["total_tokens_in"], 0);
    assert_eq!(body["total_tokens_out"], 0);
    assert!((body["total_cost_usd"].as_f64().unwrap() - 0.0).abs() < 1e-10);
}

#[tokio::test]
async fn stats_reflect_ingested_events() {
    let app = test_app();

    post_json(&app, "/api/events", json!({
        "session_id": "s1",
        "agent_type": "claude_code",
        "event_type": "tool_use",
        "tokens_in": 100,
        "tokens_out": 50,
        "cost_usd": 0.01
    })).await;

    post_json(&app, "/api/events", json!({
        "session_id": "s2",
        "agent_type": "codex",
        "event_type": "llm_request",
        "tokens_in": 200,
        "tokens_out": 100,
        "cost_usd": 0.02
    })).await;

    let (status, body) = get_json(&app, "/api/stats").await;
    assert_eq!(status, 200);
    assert_eq!(body["total_events"], 2);
    assert_eq!(body["active_sessions"], 2);
    assert_eq!(body["total_sessions"], 2);
    assert_eq!(body["total_tokens_in"], 300);
    assert_eq!(body["total_tokens_out"], 150);
    assert!((body["total_cost_usd"].as_f64().unwrap() - 0.03).abs() < 1e-10);
}

// ==================== GET /api/stream (SSE) ====================

#[tokio::test]
async fn stream_returns_sse_content_type() {
    let app = test_app();
    let req = Request::builder()
        .uri("/api/stream")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let ct = response.headers().get("content-type").unwrap().to_str().unwrap();
    assert!(ct.contains("text/event-stream"), "expected text/event-stream, got {ct}");
}

#[tokio::test]
async fn stream_sends_connected_message() {
    let app = test_app();
    let req = Request::builder()
        .uri("/api/stream")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    // Read the first chunk — should contain the connected message
    let body = response.into_body();
    let frame = body.into_data_stream();

    use futures_util::StreamExt;
    let mut stream = frame;
    if let Some(Ok(chunk)) = stream.next().await {
        let text = String::from_utf8(chunk.to_vec()).unwrap();
        assert!(text.contains("\"type\":\"connected\""), "first message should be connected, got: {text}");
    } else {
        panic!("expected at least one SSE frame");
    }
}

#[tokio::test]
async fn stream_max_clients_returns_503() {
    // Build app with max_sse_clients=1
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let mut config = Config::from_env();
    config.max_sse_clients = 1;
    let state: Arc<AppState> = AppState::new(conn, config);
    let app = agentmonitor_rs::build_router(state);

    // First client connects — keep the response alive to hold the SSE stream open
    let req1 = Request::builder()
        .uri("/api/stream")
        .body(Body::empty())
        .unwrap();
    let _resp1 = app.clone().oneshot(req1).await.unwrap();
    assert_eq!(_resp1.status().as_u16(), 200);

    // Read one frame to ensure the stream is actively held
    use futures_util::StreamExt;
    let mut body1 = _resp1.into_body().into_data_stream();
    let _connected = body1.next().await; // consume connected message

    // Second client should get 503 while first is still connected
    let req2 = Request::builder()
        .uri("/api/stream")
        .body(Body::empty())
        .unwrap();
    let resp2 = app.clone().oneshot(req2).await.unwrap();
    assert_eq!(resp2.status().as_u16(), 503);
    let bytes = resp2.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"], "SSE client limit reached");
}

// ==================== SSE hub broadcast on ingest ====================

#[tokio::test]
async fn ingest_broadcasts_event_to_sse_clients() {
    let app = test_app();

    // Connect SSE client
    let req = Request::builder()
        .uri("/api/stream")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let body = response.into_body();
    use futures_util::StreamExt;
    let mut stream = body.into_data_stream();

    // Read connected message
    let first = stream.next().await.unwrap().unwrap();
    let text = String::from_utf8(first.to_vec()).unwrap();
    assert!(text.contains("connected"));

    // Now ingest an event — it should broadcast to the SSE client
    post_json(&app, "/api/events", json!({
        "session_id": "sse-test",
        "agent_type": "claude_code",
        "event_type": "tool_use"
    })).await;

    // Read the next SSE message(s) — should contain the event broadcast
    // Use a timeout to avoid hanging if broadcast isn't wired
    let next = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        stream.next(),
    ).await;

    assert!(next.is_ok(), "expected SSE broadcast within 2 seconds");
    let chunk = next.unwrap().unwrap().unwrap();
    let msg = String::from_utf8(chunk.to_vec()).unwrap();
    assert!(msg.contains("\"type\":\"event\""), "expected event broadcast, got: {msg}");
}

// ==================== Health endpoint reflects SSE client count ====================

#[tokio::test]
async fn health_reflects_sse_client_count() {
    let app = test_app();

    // Before any SSE clients
    let (_, health1) = get_json(&app, "/api/health").await;
    assert_eq!(health1["sse_clients"], 0);

    // Connect an SSE client — keep body stream alive
    let req = Request::builder()
        .uri("/api/stream")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    use futures_util::StreamExt;
    let mut body_stream = resp.into_body().into_data_stream();
    let _connected = body_stream.next().await; // consume connected, keeps stream alive

    // After connecting
    let (_, health2) = get_json(&app, "/api/health").await;
    assert_eq!(health2["sse_clients"], 1);
}
