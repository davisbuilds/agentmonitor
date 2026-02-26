use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::runtime_host::start_with_config;

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

async fn wait_for_health(addr: SocketAddr, timeout_ms: u64) {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if let Some(200) = health_status(addr).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("health endpoint did not become ready at {addr} within {timeout_ms}ms");
}

async fn wait_for_unreachable(addr: SocketAddr, timeout_ms: u64) {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect(addr).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("server still reachable at {addr} after {timeout_ms}ms");
}

fn test_config() -> Config {
    let mut config = Config::from_env();
    config.host = "127.0.0.1".into();
    config.port = 0;
    config.auto_import_interval_minutes = 0;
    config.stats_interval_ms = 100;
    config
}

#[tokio::test]
async fn runtime_host_starts_serves_health_and_stops() {
    let host = start_with_config(test_config())
        .await
        .expect("runtime host should start");
    let addr = host.local_addr();

    wait_for_health(addr, 2_000).await;

    host.stop().await.expect("runtime host should stop cleanly");
    wait_for_unreachable(addr, 2_000).await;
}

#[tokio::test]
async fn runtime_host_releases_port_for_restart() {
    let port = 36141;
    let mut first_config = test_config();
    first_config.port = port;

    let first = start_with_config(first_config)
        .await
        .expect("first host start should succeed");
    let addr = first.local_addr();
    wait_for_health(addr, 2_000).await;
    first.stop().await.expect("first host stop should succeed");

    let mut second_config = test_config();
    second_config.port = port;
    let second = start_with_config(second_config)
        .await
        .expect("second host start should succeed on same port");
    wait_for_health(second.local_addr(), 2_000).await;
    second.stop().await.expect("second host stop should succeed");
}
