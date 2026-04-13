use std::fs;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

use agentmonitor_rs::config::Config;
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
    let app_assets_dir = app_ui_dir.join("assets");

    fs::create_dir_all(legacy_ui_dir.join("js")).expect("legacy js dir");
    fs::create_dir_all(&app_assets_dir).expect("app assets dir");

    fs::write(
        legacy_ui_dir.join("index.html"),
        "<!doctype html><html><head><title>AgentMonitor</title></head><body>legacy</body></html>",
    )
    .expect("legacy index");
    fs::write(legacy_ui_dir.join("js").join("app.js"), "reloadData();").expect("legacy js");

    fs::write(
        app_ui_dir.join("index.html"),
        "<!doctype html><html><head><title>AgentMonitor App</title><script type=\"module\" src=\"/app/assets/index-test.js\"></script></head><body><div id=\"app\"></div></body></html>",
    )
    .expect("app index");
    fs::write(app_assets_dir.join("index-test.js"), "console.log('app bundle');").expect("app asset");

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
    let state: Arc<AppState> = AppState::new(conn, config);
    TestApp {
        _ui_dirs: ui_dirs,
        app: agentmonitor_rs::build_router(state),
    }
}

#[tokio::test]
async fn root_serves_dashboard_html() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(body.contains("<title>AgentMonitor</title>"));
}

#[tokio::test]
async fn javascript_assets_are_served() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/js/app.js")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.contains("javascript"),
        "expected javascript content type, got {content_type}"
    );

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(body.contains("reloadData("));
}

#[tokio::test]
async fn app_root_serves_svelte_html() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/app/")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(body.contains("<title>AgentMonitor App</title>"));
    assert!(body.contains("/app/assets/index-test.js"));
}

#[tokio::test]
async fn app_assets_are_served_from_app_prefix() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/app/assets/index-test.js")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.contains("javascript"),
        "expected javascript content type, got {content_type}"
    );

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(body.contains("app bundle"));
}

#[tokio::test]
async fn app_unknown_paths_fall_back_to_svelte_index() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/app/sessions/abc123")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(body.contains("<title>AgentMonitor App</title>"));
}

#[tokio::test]
async fn api_routes_take_precedence_over_static_fallback() {
    let test_app = test_app();
    let req = Request::builder()
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let response = test_app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["status"], "ok");
}
