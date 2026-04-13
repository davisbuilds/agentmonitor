use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::importer::{ImportOptions, ImportSource, run_import};
use agentmonitor_rs::state::AppState;

fn setup_db() -> rusqlite::Connection {
    db::initialize(Path::new(":memory:")).expect("in-memory DB")
}

fn make_options(claude_dir: PathBuf) -> ImportOptions {
    ImportOptions {
        source: ImportSource::ClaudeCode,
        from: None,
        to: None,
        dry_run: false,
        force: false,
        claude_dir: Some(claude_dir),
        codex_dir: None,
        max_payload_kb: 64,
    }
}

fn write_jsonl(path: &Path, lines: &[Value]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    let payload = lines
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, payload).expect("write jsonl");
}

fn seed_claude_live_history(root: &Path) {
    let parent_path = root
        .join("projects")
        .join("-Users-dg-mac-mini-Dev-project-alpha")
        .join("parity-live-parent.jsonl");
    let child_path = root
        .join("projects")
        .join("-Users-dg-mac-mini-Dev-project-alpha")
        .join("agent-live-child.jsonl");

    write_jsonl(
        &parent_path,
        &[
            json!({
                "type": "user",
                "sessionId": "parity-live-parent",
                "timestamp": "2026-04-09T10:00:00Z",
                "message": { "role": "user", "content": "NeedleRustLive parent" }
            }),
            json!({
                "type": "assistant",
                "sessionId": "parity-live-parent",
                "timestamp": "2026-04-09T10:01:00Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "delegate" },
                        { "type": "tool_use", "id": "tool-1", "name": "Agent", "input": { "session_id": "agent-live-child" } },
                        { "type": "tool_result", "tool_use_id": "tool-1", "content": "NeedleRustLive delegated", "is_error": false }
                    ]
                }
            }),
            json!({
                "type": "assistant",
                "sessionId": "parity-live-parent",
                "timestamp": "2026-04-09T10:02:00Z",
                "message": { "role": "assistant", "content": "NeedleRustLive complete" }
            }),
        ],
    );

    write_jsonl(
        &child_path,
        &[
            json!({
                "type": "user",
                "sessionId": "agent-live-child",
                "timestamp": "2026-04-09T10:01:30Z",
                "message": { "role": "user", "content": "Child live prompt" }
            }),
            json!({
                "type": "assistant",
                "sessionId": "agent-live-child",
                "timestamp": "2026-04-09T10:01:45Z",
                "message": { "role": "assistant", "content": "Child live answer" }
            }),
        ],
    );
}

fn test_app() -> axum::Router {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    seed_claude_live_history(temp.path());
    run_import(&conn, &make_options(temp.path().to_path_buf()));

    let config = Config::from_env();
    let state: Arc<AppState> = AppState::new(conn, config);
    agentmonitor_rs::build_router(state)
}

async fn get_json(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = serde_json::from_slice(&bytes).expect("json response");
    (status, parsed)
}

#[tokio::test]
async fn v2_live_sessions_routes_return_imported_projection() {
    let app = test_app();

    let (status, sessions) =
        get_json(&app, "/api/v2/live/sessions?project=project-alpha&agent=claude&fidelity=full").await;
    assert_eq!(status, 200);
    assert_eq!(sessions["total"], 2);
    assert!(sessions["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "parity-live-parent" && row["capabilities"]["live_items"] == "full"));

    let (detail_status, detail) = get_json(&app, "/api/v2/live/sessions/parity-live-parent").await;
    assert_eq!(detail_status, 200);
    assert_eq!(detail["integration_mode"], "claude-jsonl");
    assert_eq!(detail["fidelity"], "full");

    let (missing_status, _) = get_json(&app, "/api/v2/live/sessions/missing-live").await;
    assert_eq!(missing_status, 404);
}

#[tokio::test]
async fn v2_live_turns_and_items_routes_match_expected_shapes() {
    let app = test_app();

    let (turns_status, turns) =
        get_json(&app, "/api/v2/live/sessions/parity-live-parent/turns").await;
    assert_eq!(turns_status, 200);
    let turns_data = turns["data"].as_array().unwrap();
    assert_eq!(turns_data.len(), 3);
    assert_eq!(turns_data[0]["source_turn_id"], "claude-message:0");

    let (items_status, items) =
        get_json(&app, "/api/v2/live/sessions/parity-live-parent/items").await;
    assert_eq!(items_status, 200);
    assert!(items["total"].as_i64().unwrap() >= items["data"].as_array().unwrap().len() as i64);
    let item_kinds = items["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["kind"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(item_kinds.contains(&"user_message"));
    assert!(item_kinds.contains(&"assistant_message"));
    assert!(item_kinds.contains(&"reasoning"));
    assert!(item_kinds.contains(&"tool_call"));
    assert!(item_kinds.contains(&"tool_result"));

    let (filtered_status, filtered_items) =
        get_json(&app, "/api/v2/live/sessions/parity-live-parent/items?kinds=reasoning,tool_call").await;
    assert_eq!(filtered_status, 200);
    assert!(filtered_items["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| matches!(row["kind"].as_str(), Some("reasoning" | "tool_call"))));
}
