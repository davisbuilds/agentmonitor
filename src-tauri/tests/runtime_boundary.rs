use agentmonitor_rs::config::Config;
use agentmonitor_tauri_lib::backend::{
    apply_desktop_bind_overrides, apply_desktop_runtime_overrides, start_embedded_backend_with_config,
    DesktopBindOverrides,
};

fn test_config() -> Config {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut config = Config::from_env();
    config.host = "127.0.0.1".to_string();
    config.port = 0;
    config.auto_import_interval_minutes = 0;
    config.stats_interval_ms = 100;
    let suffix = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    config.db_path = std::env::temp_dir().join(format!(
        "agentmonitor-tauri-boundary-test-{}-{}.db",
        std::process::id(),
        suffix
    ));
    config
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral listener");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);
    port
}

fn unique_temp_dir(name: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let suffix = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "agentmonitor-tauri-runtime-boundary-{name}-{}-{}",
        std::process::id(),
        suffix
    ))
}

#[test]
fn desktop_bind_policy_prefers_desktop_override() {
    let mut base = test_config();
    base.host = "127.0.0.1".to_string();
    base.port = 3142;

    let resolved = apply_desktop_bind_overrides(
        base,
        DesktopBindOverrides {
            host: Some("127.0.0.2".to_string()),
            port: Some(4747),
        },
    );

    assert_eq!(resolved.host, "127.0.0.2");
    assert_eq!(resolved.port, 4747);
}

#[test]
fn desktop_bind_policy_falls_back_to_base_config_without_overrides() {
    let mut base = test_config();
    base.host = "0.0.0.0".to_string();
    base.port = 4848;

    let resolved = apply_desktop_bind_overrides(base, DesktopBindOverrides::default());
    assert_eq!(resolved.host, "0.0.0.0");
    assert_eq!(resolved.port, 4848);
}

#[test]
fn desktop_db_path_is_resolved_against_app_data_dir_when_relative() {
    let mut base = test_config();
    base.db_path = std::path::PathBuf::from("./data/agentmonitor-rs.db");
    let app_data_dir = unique_temp_dir("app-data");

    let resolved = apply_desktop_runtime_overrides(
        base,
        DesktopBindOverrides::default(),
        Some(app_data_dir.as_path()),
    )
    .expect("desktop runtime overrides should resolve");

    assert_eq!(resolved.db_path, app_data_dir.join("./data/agentmonitor-rs.db"));
    assert!(
        resolved
            .db_path
            .parent()
            .expect("db path parent")
            .exists(),
        "db parent directory should be created during desktop config resolution"
    );
}

#[tokio::test]
async fn startup_contract_exposes_base_url_and_bind_address() {
    let backend = start_embedded_backend_with_config(test_config())
        .await
        .expect("embedded backend should start");

    assert_eq!(
        backend.base_url(),
        format!("http://{}", backend.local_addr())
    );

    backend
        .shutdown()
        .await
        .expect("embedded backend should stop cleanly");
}

#[tokio::test]
async fn shutdown_releases_port_and_allows_restart() {
    let fixed_port = free_port();
    let mut first_cfg = test_config();
    first_cfg.port = fixed_port;
    let first = start_embedded_backend_with_config(first_cfg)
        .await
        .expect("first backend start should succeed");
    first
        .shutdown()
        .await
        .expect("first backend should stop cleanly");

    let mut second_cfg = test_config();
    second_cfg.port = fixed_port;
    let second = start_embedded_backend_with_config(second_cfg)
        .await
        .expect("second backend start should succeed on same port");
    second
        .shutdown()
        .await
        .expect("second backend should stop cleanly");
}
