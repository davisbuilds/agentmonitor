use std::fs;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use tempfile::TempDir;
use tower::ServiceExt;

use agentmonitor_rs::config::{CodexLiveMode, Config, LiveCaptureConfig, LiveConfig};
use agentmonitor_rs::db;
use agentmonitor_rs::state::AppState;

struct TestUiDirs {
    _tmp: TempDir,
    legacy_ui_dir: std::path::PathBuf,
    app_ui_dir: std::path::PathBuf,
}

struct TestApp {
    _ui_dirs: TestUiDirs,
    app: axum::Router,
}

fn make_test_ui_dirs() -> TestUiDirs {
    let tmp = tempfile::tempdir().expect("temp dir");
    let legacy_ui_dir = tmp.path().join("public");
    let app_ui_dir = tmp.path().join("frontend-dist");

    fs::create_dir_all(&legacy_ui_dir).expect("legacy dir");
    fs::create_dir_all(&app_ui_dir).expect("app dir");
    fs::write(legacy_ui_dir.join("index.html"), "<html><body>legacy</body></html>").expect("legacy index");
    fs::write(app_ui_dir.join("index.html"), "<html><body>app</body></html>").expect("app index");

    TestUiDirs {
        _tmp: tmp,
        legacy_ui_dir,
        app_ui_dir,
    }
}

fn test_app() -> TestApp {
    let ui_dirs = make_test_ui_dirs();
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let mut config = Config::from_env();
    config.ui_dir = ui_dirs.legacy_ui_dir.clone();
    config.app_ui_dir = ui_dirs.app_ui_dir.clone();
    config.live = LiveConfig {
        enabled: false,
        codex_mode: CodexLiveMode::Exporter,
        capture: LiveCaptureConfig {
            prompts: false,
            reasoning: true,
            tool_arguments: false,
        },
        diff_payload_max_bytes: 4096,
    };
    let state: Arc<AppState> = AppState::new(conn, config);
    TestApp {
        _ui_dirs: ui_dirs,
        app: agentmonitor_rs::build_router(state),
    }
}

#[tokio::test]
async fn live_settings_matches_runtime_config() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/api/v2/live/settings")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["enabled"], false);
    assert_eq!(body["codex_mode"], "exporter");
    assert_eq!(body["capture"]["prompts"], false);
    assert_eq!(body["capture"]["reasoning"], true);
    assert_eq!(body["capture"]["tool_arguments"], false);
    assert_eq!(body["diff_payload_max_bytes"], 4096);
}
