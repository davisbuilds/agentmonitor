use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use agentmonitor_rs::config::{Config, InsightsProvider};
use agentmonitor_rs::db;
use agentmonitor_rs::importer::{ImportOptions, ImportSource, run_import};
use agentmonitor_rs::insights::service::{
    GenerateInsightParams, TestGeneratedInsight, set_insight_generator_for_tests,
};
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
                "message": { "role": "assistant", "content": "NeedleRustApi complete" }
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

async fn request_json(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
        .body(match body {
            Some(payload) => Body::from(payload.to_string()),
            None => Body::empty(),
        })
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = serde_json::from_slice(&bytes).expect("json response");
    (status, parsed)
}

fn fake_generator(params: &GenerateInsightParams) -> Result<TestGeneratedInsight, String> {
    Ok(TestGeneratedInsight {
        title: format!("{} Summary", params.kind.as_str()),
        content: format!(
            "# {} Summary\n\n## Scope\n\nSynthetic output",
            params.kind.as_str()
        ),
        provider: params.provider.clone().unwrap_or(InsightsProvider::OpenAi),
        model: params
            .model
            .clone()
            .unwrap_or_else(|| "test-model".to_string()),
    })
}

#[tokio::test]
async fn v2_insights_routes_support_generation_listing_and_deletion() {
    set_insight_generator_for_tests(Some(fake_generator));

    let app = test_app();

    let (list_status, initial) = request_json(&app, "GET", "/api/v2/insights", None).await;
    assert_eq!(list_status, 200);
    assert_eq!(initial["data"].as_array().unwrap().len(), 0);
    assert_eq!(initial["generation"]["default_provider"], "openai");

    let (create_status, created) = request_json(
        &app,
        "POST",
        "/api/v2/insights/generate",
        Some(json!({
            "kind": "overview",
            "date_from": "2026-04-09",
            "date_to": "2026-04-10",
            "project": "project-alpha",
            "agent": "claude",
            "prompt": "focus on throughput",
            "provider": "anthropic",
            "model": "claude-custom"
        })),
    )
    .await;
    assert_eq!(create_status, 201);
    assert_eq!(created["kind"], "overview");
    assert_eq!(created["title"], "overview Summary");
    assert_eq!(created["provider"], "anthropic");
    assert_eq!(created["model"], "claude-custom");
    assert_eq!(created["project"], "project-alpha");
    assert!(created["analytics_summary"].is_object());
    assert!(created["usage_summary"].is_object());
    let id = created["id"].as_i64().expect("insight id");

    let (detail_status, detail) =
        request_json(&app, "GET", &format!("/api/v2/insights/{id}"), None).await;
    assert_eq!(detail_status, 200);
    assert_eq!(detail["id"], id);

    let (filtered_status, filtered) =
        request_json(&app, "GET", "/api/v2/insights?kind=overview", None).await;
    assert_eq!(filtered_status, 200);
    assert_eq!(filtered["data"].as_array().unwrap().len(), 1);

    let (delete_status, deleted) =
        request_json(&app, "DELETE", &format!("/api/v2/insights/{id}"), None).await;
    assert_eq!(delete_status, 200);
    assert_eq!(deleted["removed"], true);

    let (missing_status, missing) =
        request_json(&app, "GET", &format!("/api/v2/insights/{id}"), None).await;
    assert_eq!(missing_status, 404);
    assert_eq!(missing["error"], "Insight not found");

    set_insight_generator_for_tests(None);
}
