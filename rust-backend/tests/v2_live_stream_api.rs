use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use futures_util::StreamExt;
use hyper::Request;
use serde_json::{Value, json};
use tower::ServiceExt;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::state::AppState;

fn setup_db() -> rusqlite::Connection {
    db::initialize(Path::new(":memory:")).expect("in-memory DB")
}

fn test_app_with_state(configure: impl FnOnce(&mut Config)) -> (axum::Router, Arc<AppState>) {
    let conn = setup_db();
    let mut config = Config::from_env();
    configure(&mut config);
    let state = AppState::new(conn, config);
    (agentmonitor_rs::build_router(Arc::clone(&state)), state)
}

async fn open_stream(
    app: &axum::Router,
    uri: &str,
) -> (
    u16,
    hyper::HeaderMap,
    axum::body::BodyDataStream,
) {
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let stream = response.into_body().into_data_stream();
    (status, headers, stream)
}

async fn read_sse_json(
    stream: &mut axum::body::BodyDataStream,
) -> Value {
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await
        .expect("SSE chunk within timeout")
        .expect("SSE frame present")
        .expect("SSE frame bytes");
    let text = String::from_utf8(chunk.to_vec()).expect("utf8 SSE frame");
    let data = text
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("SSE data line");
    serde_json::from_str(data).expect("SSE json")
}

#[tokio::test]
async fn live_stream_replays_buffered_events_and_respects_filters() {
    let (app, state) = test_app_with_state(|config| {
        config.max_sse_clients = 2;
    });

    state
        .live_sse_hub
        .broadcast(
            "session_presence",
            json!({ "session_id": "session-a", "live_status": "live" }),
        )
        .await;
    state
        .live_sse_hub
        .broadcast("item_delta", json!({ "session_id": "session-b", "inserted_items": 1 }))
        .await;

    let (status, headers, mut stream) =
        open_stream(&app, "/api/v2/live/stream?since=1&session_id=session-b").await;
    assert_eq!(status, 200);
    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.contains("text/event-stream"),
        "expected SSE content type, got {content_type}"
    );

    let replayed = read_sse_json(&mut stream).await;
    let connected = read_sse_json(&mut stream).await;

    assert_eq!(replayed["type"], "item_delta");
    assert_eq!(replayed["payload"]["session_id"], "session-b");
    assert_eq!(connected["type"], "connected");
    assert_eq!(connected["payload"]["replayed"], 1);
}

#[tokio::test]
async fn live_stream_enforces_max_clients_and_recovers_after_disconnect() {
    let (app, _state) = test_app_with_state(|config| {
        config.max_sse_clients = 1;
    });

    let (status1, _headers1, mut stream1) = open_stream(&app, "/api/v2/live/stream").await;
    assert_eq!(status1, 200);
    let connected = read_sse_json(&mut stream1).await;
    assert_eq!(connected["type"], "connected");

    let req2 = Request::builder()
        .uri("/api/v2/live/stream")
        .body(Body::empty())
        .unwrap();
    let blocked = app.clone().oneshot(req2).await.unwrap();
    assert_eq!(blocked.status().as_u16(), 503);
    let blocked_body = http_body_util::BodyExt::collect(blocked.into_body())
        .await
        .unwrap()
        .to_bytes();
    let blocked_json: Value = serde_json::from_slice(&blocked_body).expect("503 json");
    assert_eq!(blocked_json["error"], "SSE client limit reached");
    assert_eq!(blocked_json["max_clients"], 1);

    drop(stream1);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;

    let (status3, _headers3, mut stream3) = open_stream(&app, "/api/v2/live/stream").await;
    assert_eq!(status3, 200);
    let reconnected = read_sse_json(&mut stream3).await;
    assert_eq!(reconnected["type"], "connected");
}
