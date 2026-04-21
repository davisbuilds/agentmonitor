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

fn seed_claude_history(root: &Path) {
    let parent_path = root
        .join("projects")
        .join("-Users-dg-mac-mini-Dev-project-alpha")
        .join("parity-v2-parent.jsonl");
    let child_path = root
        .join("projects")
        .join("-Users-dg-mac-mini-Dev-project-alpha")
        .join("agent-child-1.jsonl");

    write_jsonl(
        &parent_path,
        &[
            json!({
                "type": "user",
                "sessionId": "parity-v2-parent",
                "timestamp": "2026-04-09T10:00:00Z",
                "message": { "role": "user", "content": "NeedleRustApi parent" }
            }),
            json!({
                "type": "assistant",
                "sessionId": "parity-v2-parent",
                "timestamp": "2026-04-09T10:01:00Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "delegate" },
                        { "type": "tool_use", "id": "tool-1", "name": "Agent", "input": { "session_id": "agent-child-1" } },
                        { "type": "tool_result", "tool_use_id": "tool-1", "content": "NeedleRustApi delegated", "is_error": false }
                    ]
                }
            }),
            json!({
                "type": "assistant",
                "sessionId": "parity-v2-parent",
                "timestamp": "2026-04-09T10:02:00Z",
                "message": { "role": "assistant", "content": "NeedleRustApi complete" }
            }),
        ],
    );

    write_jsonl(
        &child_path,
        &[
            json!({
                "type": "user",
                "sessionId": "agent-child-1",
                "timestamp": "2026-04-09T10:01:30Z",
                "message": { "role": "user", "content": "Child prompt" }
            }),
            json!({
                "type": "assistant",
                "sessionId": "agent-child-1",
                "timestamp": "2026-04-09T10:01:45Z",
                "message": { "role": "assistant", "content": "Child answer" }
            }),
        ],
    );
}

fn seed_usage_events(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO events (
            session_id, agent_type, event_type, status, project, source, client_timestamp,
            model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd
        ) VALUES
        ('parity-v2-parent', 'claude', 'llm_response', 'success', 'project-alpha', 'import', '2026-04-09T10:00:00Z', 'claude-sonnet-4', 120, 30, 10, 0, 0.6),
        ('parity-v2-parent', 'claude', 'message', 'success', 'project-alpha', 'otel', '2026-04-09T10:05:00Z', NULL, 0, 0, 0, 0, NULL),
        ('agent-child-1', 'claude', 'llm_response', 'success', 'project-alpha', 'otel', '2026-04-09T10:03:00Z', 'claude-sonnet-4', 60, 15, 0, 0, 0.2),
        ('orphan-usage', 'codex', 'llm_response', 'success', 'project-alpha', 'api', '2026-04-10T11:00:00Z', 'gpt-5.4', 80, 20, 0, 0, 0.9)",
        [],
    )
    .unwrap();
}

fn test_app() -> axum::Router {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    seed_claude_history(temp.path());
    run_import(&conn, &make_options(temp.path().to_path_buf()));
    seed_usage_events(&conn);

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

async fn post_empty(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = serde_json::from_slice(&bytes).expect("json response");
    (status, parsed)
}

async fn delete_empty(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .method("DELETE")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = serde_json::from_slice(&bytes).expect("json response");
    (status, parsed)
}

#[tokio::test]
async fn v2_sessions_routes_return_imported_history() {
    let app = test_app();

    let (status, sessions) =
        get_json(&app, "/api/v2/sessions?project=project-alpha&agent=claude").await;
    assert_eq!(status, 200);
    assert_eq!(sessions["total"], 2);
    assert!(sessions["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "parity-v2-parent" && row["integration_mode"] == "claude-jsonl"));

    let (detail_status, detail) = get_json(&app, "/api/v2/sessions/parity-v2-parent").await;
    assert_eq!(detail_status, 200);
    assert_eq!(detail["message_count"], 3);
    assert_eq!(detail["capabilities"]["history"], "full");

    let (messages_status, messages) =
        get_json(&app, "/api/v2/sessions/parity-v2-parent/messages").await;
    assert_eq!(messages_status, 200);
    assert_eq!(messages["total"], 3);
    assert_eq!(messages["data"].as_array().unwrap()[0]["role"], "user");

    let (activity_status, activity) =
        get_json(&app, "/api/v2/sessions/parity-v2-parent/activity").await;
    assert_eq!(activity_status, 200);
    assert_eq!(activity["total_messages"], 3);
    assert_eq!(activity["bucket_count"], 8);
    assert_eq!(activity["data"].as_array().unwrap().len(), 8);

    let (children_status, children) =
        get_json(&app, "/api/v2/sessions/parity-v2-parent/children").await;
    assert_eq!(children_status, 200);
    assert_eq!(children["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        children["data"].as_array().unwrap()[0]["id"],
        "agent-child-1"
    );
}

#[tokio::test]
async fn v2_search_analytics_and_metadata_routes_match_contract() {
    let app = test_app();

    let (search_status, search) =
        get_json(&app, "/api/v2/search?q=NeedleRustApi&project=project-alpha").await;
    assert_eq!(search_status, 200);
    assert!(search["total"].as_i64().unwrap() >= 1);
    assert!(search["data"].as_array().unwrap().iter().any(|row| {
        row["snippet"]
            .as_str()
            .unwrap_or_default()
            .contains("<mark>")
    }));
    assert!(
        search["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(
                |row| row["session_project"] == "project-alpha" && row["session_agent"] == "claude"
            )
    );

    let (relevance_status, relevance) = get_json(
        &app,
        "/api/v2/search?q=NeedleRustApi&project=project-alpha&sort=relevance",
    )
    .await;
    assert_eq!(relevance_status, 200);
    assert!(relevance["total"].as_i64().unwrap() >= 1);

    let (summary_status, summary) = get_json(
        &app,
        "/api/v2/analytics/summary?project=project-alpha&agent=claude",
    )
    .await;
    assert_eq!(summary_status, 200);
    assert_eq!(summary["total_sessions"], 2);
    assert_eq!(summary["total_messages"], 5);
    assert_eq!(summary["coverage"]["matching_sessions"], 2);
    assert_eq!(summary["coverage"]["included_sessions"], 2);

    let (tools_status, tools) =
        get_json(&app, "/api/v2/analytics/tools?project=project-alpha").await;
    assert_eq!(tools_status, 200);
    assert!(
        tools["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["tool_name"] == "Agent")
    );
    assert_eq!(tools["coverage"]["metric_scope"], "tool_analytics_capable");

    let (activity_status, activity) =
        get_json(&app, "/api/v2/analytics/activity?project=project-alpha").await;
    assert_eq!(activity_status, 200);
    assert_eq!(activity["coverage"]["matching_sessions"], 2);
    assert_eq!(activity["data"].as_array().unwrap().len(), 1);

    let (hour_status, hour_of_week) =
        get_json(&app, "/api/v2/analytics/hour-of-week?project=project-alpha").await;
    assert_eq!(hour_status, 200);
    assert_eq!(hour_of_week["data"].as_array().unwrap().len(), 168);

    let (top_status, top_sessions) = get_json(
        &app,
        "/api/v2/analytics/top-sessions?project=project-alpha&limit=1",
    )
    .await;
    assert_eq!(top_status, 200);
    assert_eq!(top_sessions["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        top_sessions["data"].as_array().unwrap()[0]["id"],
        "parity-v2-parent"
    );

    let (velocity_status, velocity) =
        get_json(&app, "/api/v2/analytics/velocity?project=project-alpha").await;
    assert_eq!(velocity_status, 200);
    assert_eq!(velocity["total_sessions"], 2);
    assert_eq!(velocity["coverage"]["matching_sessions"], 2);

    let (agents_analytics_status, agents_analytics) =
        get_json(&app, "/api/v2/analytics/agents?project=project-alpha").await;
    assert_eq!(agents_analytics_status, 200);
    assert_eq!(agents_analytics["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        agents_analytics["data"].as_array().unwrap()[0]["agent"],
        "claude"
    );

    let (usage_summary_status, usage_summary) =
        get_json(&app, "/api/v2/usage/summary?project=project-alpha").await;
    assert_eq!(usage_summary_status, 200);
    assert!((usage_summary["total_cost_usd"].as_f64().unwrap() - 1.7).abs() < 1e-9);
    assert_eq!(usage_summary["total_usage_events"], 3);
    assert_eq!(usage_summary["coverage"]["matching_events"], 4);

    let (usage_daily_status, usage_daily) =
        get_json(&app, "/api/v2/usage/daily?project=project-alpha").await;
    assert_eq!(usage_daily_status, 200);
    assert_eq!(usage_daily["data"].as_array().unwrap().len(), 2);
    assert_eq!(usage_daily["coverage"]["usage_events"], 3);

    let (usage_projects_status, usage_projects) =
        get_json(&app, "/api/v2/usage/projects?project=project-alpha").await;
    assert_eq!(usage_projects_status, 200);
    assert_eq!(usage_projects["data"].as_array().unwrap().len(), 1);

    let (usage_models_status, usage_models) =
        get_json(&app, "/api/v2/usage/models?project=project-alpha").await;
    assert_eq!(usage_models_status, 200);
    assert_eq!(usage_models["data"].as_array().unwrap().len(), 2);

    let (usage_agents_status, usage_agents) =
        get_json(&app, "/api/v2/usage/agents?project=project-alpha").await;
    assert_eq!(usage_agents_status, 200);
    assert_eq!(usage_agents["data"].as_array().unwrap().len(), 2);

    let (usage_top_status, usage_top_sessions) = get_json(
        &app,
        "/api/v2/usage/top-sessions?project=project-alpha&limit=3",
    )
    .await;
    assert_eq!(usage_top_status, 200);
    assert_eq!(usage_top_sessions["data"].as_array().unwrap().len(), 3);
    assert_eq!(
        usage_top_sessions["data"].as_array().unwrap()[0]["id"],
        "orphan-usage"
    );
    assert_eq!(
        usage_top_sessions["data"].as_array().unwrap()[0]["browsing_session_available"],
        false
    );

    let (projects_status, projects) = get_json(&app, "/api/v2/projects").await;
    assert_eq!(projects_status, 200);
    assert_eq!(
        projects["data"].as_array().unwrap(),
        &[Value::String("project-alpha".into())]
    );

    let (agents_status, agents) = get_json(&app, "/api/v2/agents").await;
    assert_eq!(agents_status, 200);
    assert_eq!(
        agents["data"].as_array().unwrap(),
        &[Value::String("claude".into())]
    );
}

#[tokio::test]
async fn v2_pin_routes_round_trip_messages() {
    let app = test_app();

    let (messages_status, messages) =
        get_json(&app, "/api/v2/sessions/parity-v2-parent/messages?limit=1").await;
    assert_eq!(messages_status, 200);
    let message_id = messages["data"].as_array().unwrap()[0]["id"]
        .as_i64()
        .expect("message id");

    let (pin_status, pin) = post_empty(
        &app,
        &format!("/api/v2/sessions/parity-v2-parent/messages/{message_id}/pin"),
    )
    .await;
    assert_eq!(pin_status, 201);
    assert_eq!(pin["session_id"], "parity-v2-parent");
    assert_eq!(pin["message_ordinal"], 0);
    assert_eq!(pin["session_project"], "project-alpha");

    let (session_pins_status, session_pins) =
        get_json(&app, "/api/v2/sessions/parity-v2-parent/pins").await;
    assert_eq!(session_pins_status, 200);
    assert_eq!(session_pins["data"].as_array().unwrap().len(), 1);

    let (all_pins_status, all_pins) = get_json(&app, "/api/v2/pins?project=project-alpha").await;
    assert_eq!(all_pins_status, 200);
    assert_eq!(all_pins["data"].as_array().unwrap().len(), 1);

    let (unpin_status, unpin) = delete_empty(
        &app,
        &format!("/api/v2/sessions/parity-v2-parent/messages/{message_id}/pin"),
    )
    .await;
    assert_eq!(unpin_status, 200);
    assert_eq!(unpin["removed"], true);
    assert_eq!(unpin["message_ordinal"], 0);
}

#[tokio::test]
async fn v2_search_requires_query_text() {
    let app = test_app();
    let (status, body) = get_json(&app, "/api/v2/search").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "Query parameter \"q\" is required");
}
