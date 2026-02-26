use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use tempfile::TempDir;

use agentmonitor_rs::db;
use agentmonitor_rs::importer::{ImportOptions, ImportSource, run_import};

fn setup_db() -> rusqlite::Connection {
    db::initialize(Path::new(":memory:")).expect("in-memory DB")
}

fn make_options(source: ImportSource) -> ImportOptions {
    ImportOptions {
        source,
        from: None,
        to: None,
        dry_run: false,
        force: false,
        claude_dir: None,
        codex_dir: None,
        max_payload_kb: 64,
    }
}

fn write_jsonl(path: &Path, lines: &[Value]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    let data = lines
        .iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, data).expect("write jsonl");
}

fn create_claude_fixture(root: &Path) -> PathBuf {
    let file_path = root
        .join("projects")
        .join("my-project")
        .join("session-abc.jsonl");
    write_jsonl(
        &file_path,
        &[
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
        ],
    );
    file_path
}

fn create_codex_fixture(root: &Path) -> PathBuf {
    fs::create_dir_all(root.join("sessions").join("2026").join("02").join("01"))
        .expect("create codex sessions dir");
    fs::write(root.join("config.toml"), "model = \"o3\"\n").expect("write config.toml");

    let file_path = root
        .join("sessions")
        .join("2026")
        .join("02")
        .join("01")
        .join("session-xyz.jsonl");
    write_jsonl(
        &file_path,
        &[
            json!({
                "type": "session_meta",
                "timestamp": "2026-02-01T11:00:00Z",
                "payload": {
                    "id": "session-xyz",
                    "cwd": "/home/user/project",
                    "timestamp": "2026-02-01T11:00:00Z"
                }
            }),
            json!({
                "type": "event_msg",
                "timestamp": "2026-02-01T11:01:00Z",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 500,
                            "output_tokens": 100
                        }
                    }
                }
            }),
        ],
    );
    file_path
}

#[test]
fn imports_claude_logs_and_tracks_import_state() {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    create_claude_fixture(temp.path());

    let mut options = make_options(ImportSource::ClaudeCode);
    options.claude_dir = Some(temp.path().to_path_buf());
    let result = run_import(&conn, &options);

    assert_eq!(result.total_files, 1);
    assert_eq!(result.total_events_imported, 2);
    assert_eq!(result.total_duplicates, 0);
    assert_eq!(result.skipped_files, 0);

    let imported_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE source = 'import' AND agent_type = 'claude_code'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(imported_count, 2);

    let tool_cost: Option<f64> = conn
        .query_row(
            "SELECT cost_usd FROM events WHERE event_type = 'tool_use' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(tool_cost.unwrap_or(0.0) > 0.0);

    let state_row: (String, i64) = conn
        .query_row(
            "SELECT source, events_imported FROM import_state LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state_row.0, "claude-code");
    assert_eq!(state_row.1, 2);
}

#[test]
fn skips_unchanged_files_without_force() {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    create_claude_fixture(temp.path());

    let mut options = make_options(ImportSource::ClaudeCode);
    options.claude_dir = Some(temp.path().to_path_buf());
    let first = run_import(&conn, &options);
    assert_eq!(first.total_events_imported, 2);

    let second = run_import(&conn, &options);
    assert_eq!(second.skipped_files, 1);
    assert_eq!(second.total_events_imported, 0);
}

#[test]
fn force_reimport_processes_file_and_counts_duplicates() {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    create_claude_fixture(temp.path());

    let mut options = make_options(ImportSource::ClaudeCode);
    options.claude_dir = Some(temp.path().to_path_buf());
    let first = run_import(&conn, &options);
    assert_eq!(first.total_events_imported, 2);

    options.force = true;
    let forced = run_import(&conn, &options);
    assert_eq!(forced.skipped_files, 0);
    assert_eq!(forced.total_files, 1);
    assert_eq!(forced.total_duplicates, 2);
    assert_eq!(forced.total_events_imported, 0);
}

#[test]
fn dry_run_does_not_write_to_database() {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    create_claude_fixture(temp.path());

    let mut options = make_options(ImportSource::ClaudeCode);
    options.claude_dir = Some(temp.path().to_path_buf());
    options.dry_run = true;
    let result = run_import(&conn, &options);

    assert_eq!(result.total_events_found, 2);
    assert_eq!(result.total_events_imported, 2);

    let total_events: i64 = conn
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(total_events, 0);
}

#[test]
fn imports_codex_session_meta_and_token_counts() {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    create_codex_fixture(temp.path());

    let mut options = make_options(ImportSource::Codex);
    options.codex_dir = Some(temp.path().to_path_buf());
    let result = run_import(&conn, &options);

    assert_eq!(result.total_files, 1);
    assert_eq!(result.total_events_imported, 3);

    let codex_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE source = 'import' AND agent_type = 'codex'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(codex_count, 3);

    let response_cost: Option<f64> = conn
        .query_row(
            "SELECT cost_usd FROM events WHERE agent_type = 'codex' AND event_type = 'llm_response' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(response_cost.unwrap_or(0.0) > 0.0);
}

#[test]
fn date_filters_limit_imported_events() {
    let conn = setup_db();
    let temp = TempDir::new().expect("temp dir");
    create_claude_fixture(temp.path());

    let mut options = make_options(ImportSource::ClaudeCode);
    options.claude_dir = Some(temp.path().to_path_buf());
    options.from = Some(
        DateTime::parse_from_rfc3339("2026-02-01T10:00:30Z")
            .unwrap()
            .with_timezone(&Utc),
    );
    let result = run_import(&conn, &options);
    assert_eq!(result.total_events_imported, 1);
}
