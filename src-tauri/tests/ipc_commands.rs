use agentmonitor_rs::config::Config;
use agentmonitor_tauri_lib::backend::{start_embedded_backend_with_config, EmbeddedBackendState};
use agentmonitor_tauri_lib::ipc::{desktop_health_from_state, runtime_status_from_state};

fn test_config() -> Config {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut config = Config::from_env();
    config.host = "127.0.0.1".to_string();
    config.port = 0;
    config.auto_import_interval_minutes = 0;
    config.stats_interval_ms = 100;
    let suffix = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    config.db_path = std::env::temp_dir().join(format!(
        "agentmonitor-tauri-ipc-test-{}-{}.db",
        std::process::id(),
        suffix
    ));
    config
}

#[tokio::test]
async fn runtime_status_reports_live_backend_endpoint() {
    let backend = start_embedded_backend_with_config(test_config())
        .await
        .expect("embedded backend should start");
    let expected_base_url = backend.base_url().to_string();
    let expected_addr = backend.local_addr().to_string();

    let state = EmbeddedBackendState::new(backend);
    let status = runtime_status_from_state(&state).expect("runtime status should succeed");

    assert_eq!(status.backend_transport, "http");
    assert!(status.ipc_enabled);
    assert_eq!(status.backend_base_url, expected_base_url);
    assert_eq!(status.backend_addr, expected_addr);

    state
        .shutdown_async()
        .await
        .expect("embedded backend should stop cleanly");
}

#[tokio::test]
async fn desktop_health_reads_embedded_backend_health() {
    let backend = start_embedded_backend_with_config(test_config())
        .await
        .expect("embedded backend should start");
    let state = EmbeddedBackendState::new(backend);

    let health = desktop_health_from_state(&state)
        .await
        .expect("desktop health command should succeed");

    assert_eq!(health.http_status, 200);
    assert_eq!(health.status, "ok");

    state
        .shutdown_async()
        .await
        .expect("embedded backend should stop cleanly");
}
