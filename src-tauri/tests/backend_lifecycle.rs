use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use agentmonitor_rs::config::Config;
use agentmonitor_tauri_lib::backend::start_embedded_backend_with_config;

async fn health_status(addr: SocketAddr) -> Option<u16> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        addr
    );
    stream.write_all(request.as_bytes()).await.ok()?;

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.ok()?;
    let response = String::from_utf8_lossy(&buf);
    let status_line = response.lines().next()?;
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
}

fn test_config() -> Config {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut config = Config::from_env();
    config.host = "127.0.0.1".to_string();
    config.port = 0;
    config.auto_import_interval_minutes = 0;
    config.stats_interval_ms = 100;
    let suffix = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    config.db_path = std::env::temp_dir().join(format!(
        "agentmonitor-tauri-test-{}-{}.db",
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

#[tokio::test]
async fn start_embedded_backend_with_config_serves_health() {
    let backend = start_embedded_backend_with_config(test_config())
        .await
        .expect("embedded backend should start");
    assert!(
        backend.base_url().starts_with("http://"),
        "embedded backend should expose an absolute base URL"
    );
    let status = health_status(backend.local_addr()).await;
    assert_eq!(status, Some(200));
    backend
        .shutdown()
        .await
        .expect("embedded backend should stop cleanly");
}

#[tokio::test]
async fn start_embedded_backend_with_config_reports_bind_collisions() {
    let fixed_port = free_port();
    let mut first_cfg = test_config();
    first_cfg.port = fixed_port;

    let first = start_embedded_backend_with_config(first_cfg)
        .await
        .expect("first backend start should succeed");

    let mut second_cfg = test_config();
    second_cfg.port = fixed_port;

    let err = match start_embedded_backend_with_config(second_cfg).await {
        Ok(_) => panic!("second start should fail on occupied port"),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("Failed to bind embedded backend"),
        "expected explicit bind failure message, got: {err}"
    );

    first
        .shutdown()
        .await
        .expect("first backend should stop cleanly");
}
