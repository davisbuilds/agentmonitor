use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use serde_json::{Value, json};
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
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    (status, parsed)
}

#[tokio::test]
async fn sessions_list_returns_envelope_shape() {
    let app = test_app();
    let (status, body) = get_json(&app, "/api/sessions").await;

    assert_eq!(status, 200);
    assert!(body["sessions"].is_array());
    assert!(body["total"].is_number());
}

#[tokio::test]
async fn sessions_list_supports_agent_type_filter() {
    let app = test_app();
    let session_id = "sess-filtered";
    let agent_type = "filter_agent";

    let (insert_status, _) = post_json(
        &app,
        "/api/events",
        json!({
            "session_id": session_id,
            "agent_type": agent_type,
            "event_type": "tool_use"
        }),
    )
    .await;
    assert_eq!(insert_status, 201);

    let (status, body) = get_json(&app, "/api/sessions?agent_type=filter_agent").await;
    assert_eq!(status, 200);
    assert!(
        body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == session_id)
    );
}

#[tokio::test]
async fn session_detail_returns_404_for_unknown_session() {
    let app = test_app();
    let (status, body) = get_json(&app, "/api/sessions/missing-session").await;
    assert_eq!(status, 404);
    assert_eq!(body["error"], "Session not found");
}

#[tokio::test]
async fn session_detail_honors_event_limit() {
    let app = test_app();

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "sess-detail",
            "agent_type": "claude_code",
            "event_type": "user_prompt",
            "metadata": { "message": "hello" }
        }),
    )
    .await;

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "sess-detail",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": "Read"
        }),
    )
    .await;

    let (status, body) = get_json(&app, "/api/sessions/sess-detail?event_limit=1").await;
    assert_eq!(status, 200);
    assert_eq!(body["session"]["id"], "sess-detail");
    assert_eq!(body["events"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn transcript_returns_404_when_session_has_no_events() {
    let app = test_app();
    let (status, body) = get_json(&app, "/api/sessions/no-transcript/transcript").await;
    assert_eq!(status, 404);
    assert_eq!(body["error"], "No transcript data for this session");
}

#[tokio::test]
async fn transcript_maps_entries_with_roles() {
    let app = test_app();

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "sess-transcript",
            "agent_type": "claude_code",
            "event_type": "user_prompt",
            "metadata": { "message": "Summarize this" }
        }),
    )
    .await;

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "sess-transcript",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": "Read"
        }),
    )
    .await;

    let (status, body) = get_json(&app, "/api/sessions/sess-transcript/transcript").await;
    assert_eq!(status, 200);
    assert_eq!(body["session_id"], "sess-transcript");

    let entries = body["entries"].as_array().unwrap();
    assert!(!entries.is_empty());
    assert!(entries.iter().any(|entry| entry["role"] == "user"));
    assert!(entries.iter().any(|entry| entry["role"] == "tool"));
}

#[tokio::test]
async fn filter_options_includes_ingested_values() {
    let app = test_app();

    let (insert_status, _) = post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "sess-filters",
            "agent_type": "filter_agent_two",
            "event_type": "tool_use",
            "tool_name": "Edit",
            "model": "gpt-4.1-mini",
            "project": "project-alpha",
            "branch": "feature/parity",
            "source": "api"
        }),
    )
    .await;
    assert_eq!(insert_status, 201);

    let (status, body) = get_json(&app, "/api/filter-options").await;
    assert_eq!(status, 200);

    assert!(
        body["agent_types"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "filter_agent_two")
    );
    assert!(
        body["event_types"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "tool_use")
    );
    assert!(
        body["tool_names"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "Edit")
    );
    assert!(
        body["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "gpt-4.1-mini")
    );
    assert!(
        body["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "project-alpha")
    );
    assert!(
        body["branches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["value"] == "feature/parity")
    );
    assert!(
        body["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "api")
    );
}
