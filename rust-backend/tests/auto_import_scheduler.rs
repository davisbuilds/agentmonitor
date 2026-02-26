use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tempfile::TempDir;

use agentmonitor_rs::auto_import::run_auto_import_once_with_dirs;
use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::state::AppState;

fn create_claude_fixture(root: &Path) {
    let file_path = root
        .join("projects")
        .join("my-project")
        .join("session-abc.jsonl");
    fs::create_dir_all(file_path.parent().unwrap()).expect("create fixture dirs");
    let lines = vec![
        json!({
            "type": "tool_use",
            "sessionId": "session-abc",
            "name": "Bash",
            "model": "claude-sonnet-4-5-20250929",
            "timestamp": "2026-02-01T10:00:00Z",
            "usage": { "input_tokens": 1000, "output_tokens": 200 }
        }),
        json!({
            "type": "assistant",
            "sessionId": "session-abc",
            "model": "claude-sonnet-4-5-20250929",
            "timestamp": "2026-02-01T10:01:00Z",
            "costUSD": 0.01,
            "usage": { "input_tokens": 2000, "output_tokens": 500 }
        }),
    ];
    fs::write(
        file_path,
        lines
            .into_iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .expect("write fixture file");
}

fn build_state() -> Arc<AppState> {
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let config = Config::from_env();
    AppState::new(conn, config)
}

#[tokio::test]
async fn auto_import_broadcasts_session_update_when_new_events_imported() {
    let claude_dir = TempDir::new().expect("claude temp dir");
    let codex_dir = TempDir::new().expect("codex temp dir");
    create_claude_fixture(claude_dir.path());

    let state = build_state();
    let client = state.sse_hub.subscribe().expect("expected SSE client slot");
    let (mut rx, _guard) = client.into_parts();

    let result = run_auto_import_once_with_dirs(
        Arc::clone(&state),
        Some(claude_dir.path().to_path_buf()),
        Some(codex_dir.path().to_path_buf()),
    )
    .await;
    assert_eq!(result.total_events_imported, 2);

    let msg = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("expected broadcast within timeout")
        .expect("broadcast channel recv failed");
    assert!(msg.contains("\"type\":\"session_update\""));
    assert!(msg.contains("\"type\":\"auto_import\""));
    assert!(msg.contains("\"imported\":2"));
}

#[tokio::test]
async fn auto_import_does_not_broadcast_when_no_new_events_imported() {
    let claude_dir = TempDir::new().expect("claude temp dir");
    let codex_dir = TempDir::new().expect("codex temp dir");
    create_claude_fixture(claude_dir.path());

    let state = build_state();
    let client = state.sse_hub.subscribe().expect("expected SSE client slot");
    let (mut rx, _guard) = client.into_parts();

    let first = run_auto_import_once_with_dirs(
        Arc::clone(&state),
        Some(claude_dir.path().to_path_buf()),
        Some(codex_dir.path().to_path_buf()),
    )
    .await;
    assert_eq!(first.total_events_imported, 2);
    let _first_msg = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("expected first broadcast")
        .expect("first recv failed");

    let second = run_auto_import_once_with_dirs(
        Arc::clone(&state),
        Some(claude_dir.path().to_path_buf()),
        Some(codex_dir.path().to_path_buf()),
    )
    .await;
    assert_eq!(second.total_events_imported, 0);
    assert_eq!(second.skipped_files, 1);

    let maybe_second = tokio::time::timeout(Duration::from_millis(250), rx.recv()).await;
    assert!(
        maybe_second.is_err(),
        "did not expect auto_import broadcast when imported count is zero"
    );
}
