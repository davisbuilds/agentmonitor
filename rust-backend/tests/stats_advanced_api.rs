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
async fn stats_tools_returns_shape_and_data() {
    let app = test_app();

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "tools-sess",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": "ParityToolRust",
            "status": "error",
            "duration_ms": 250
        }),
    )
    .await;

    let (status, body) = get_json(
        &app,
        "/api/stats/tools?agent_type=claude_code&since=1970-01-01T00:00:00Z",
    )
    .await;
    assert_eq!(status, 200);

    let tools = body["tools"].as_array().unwrap();
    assert!(!tools.is_empty());
    let tool_row = tools.iter().find(|r| r["tool_name"] == "ParityToolRust");
    assert!(tool_row.is_some());
}

#[tokio::test]
async fn stats_cost_returns_shape_and_breakdowns() {
    let app = test_app();

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "cost-sess",
            "agent_type": "codex",
            "event_type": "llm_response",
            "project": "proj-rust",
            "model": "model-rust",
            "tokens_in": 120,
            "tokens_out": 80,
            "cost_usd": 1.5
        }),
    )
    .await;

    let (status, body) = get_json(
        &app,
        "/api/stats/cost?agent_type=codex&since=1970-01-01T00:00:00Z&limit=25",
    )
    .await;
    assert_eq!(status, 200);
    assert!(body["timeline"].is_array());
    assert!(body["by_project"].is_array());
    assert!(body["by_model"].is_array());

    assert!(
        body["by_project"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["project"] == "proj-rust")
    );
    assert!(
        body["by_model"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["model"] == "model-rust")
    );
}

#[tokio::test]
async fn usage_monitor_returns_claude_and_codex_shapes() {
    let app = test_app();

    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "usage-claude",
            "agent_type": "claude_code",
            "event_type": "llm_response",
            "tokens_in": 100,
            "tokens_out": 200
        }),
    )
    .await;
    post_json(
        &app,
        "/api/events",
        json!({
            "session_id": "usage-codex",
            "agent_type": "codex",
            "event_type": "llm_response",
            "cost_usd": 2.25
        }),
    )
    .await;

    let (status, body) = get_json(&app, "/api/stats/usage-monitor").await;
    assert_eq!(status, 200);
    assert!(body.is_array());

    let rows = body.as_array().unwrap();
    let claude = rows.iter().find(|row| row["agent_type"] == "claude_code");
    assert!(claude.is_some());
    assert_eq!(claude.unwrap()["limitType"], "tokens");

    let codex = rows.iter().find(|row| row["agent_type"] == "codex");
    assert!(codex.is_some());
    assert_eq!(codex.unwrap()["limitType"], "cost");
}
