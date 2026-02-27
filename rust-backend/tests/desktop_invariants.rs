use std::net::SocketAddr;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::runtime_host::{RuntimeHost, start_with_config};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct TestRuntime {
    _tmp_dir: TempDir,
    host: RuntimeHost,
    addr: SocketAddr,
}

impl TestRuntime {
    async fn start() -> Self {
        let tmp_dir = tempfile::tempdir().expect("create temp dir");
        let mut config = Config::from_env();
        config.host = "127.0.0.1".to_string();
        config.port = 0;
        config.db_path = tmp_dir.path().join("agentmonitor.db");
        config.auto_import_interval_minutes = 0;
        config.stats_interval_ms = 60_000;

        let host = start_with_config(config).await.expect("start runtime host");
        let addr = host.local_addr();
        wait_for_health(addr, 2_000).await;

        Self {
            _tmp_dir: tmp_dir,
            host,
            addr,
        }
    }

    async fn stop(self) {
        self.host.stop().await.expect("stop runtime host");
    }
}

async fn http_get_json(addr: SocketAddr, path: &str) -> (u16, Value) {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n",
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    parse_http_json_response(&response)
}

async fn http_post_json(addr: SocketAddr, path: &str, body: &Value) -> (u16, Value) {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let json = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        json.len(),
        json
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    parse_http_json_response(&response)
}

fn parse_http_json_response(raw: &[u8]) -> (u16, Value) {
    let split_at = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("response header/body separator")
        + 4;
    let (headers, body) = raw.split_at(split_at);
    let headers = String::from_utf8_lossy(headers);
    let status_line = headers.lines().next().expect("status line");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .expect("status code");
    let json: Value = serde_json::from_slice(body).expect("json body");
    (status, json)
}

fn parse_http_status_and_headers(raw: &[u8]) -> (u16, String, Vec<u8>) {
    let split_at = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("response header/body separator")
        + 4;
    let (headers, body) = raw.split_at(split_at);
    let headers_str = String::from_utf8_lossy(headers).to_string();
    let status_line = headers_str.lines().next().expect("status line");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .expect("status code");
    (status, headers_str, body.to_vec())
}

async fn wait_for_health(addr: SocketAddr, timeout_ms: u64) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(addr).await {
            let request = format!(
                "GET /api/health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n",
            );
            if stream.write_all(request.as_bytes()).await.is_ok() {
                let mut response = Vec::new();
                if stream.read_to_end(&mut response).await.is_ok() {
                    let (status, _) = parse_http_json_response(&response);
                    if status == 200 {
                        return;
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("health did not become ready at {addr} in {timeout_ms}ms");
}

async fn open_sse(addr: SocketAddr) -> (TcpStream, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).await.expect("connect SSE");
    let request = format!(
        "GET /api/stream HTTP/1.0\r\nHost: {addr}\r\nAccept: text/event-stream\r\n\r\n",
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write SSE request");

    let mut buffer = Vec::new();
    loop {
        let mut chunk = [0_u8; 4096];
        let n = stream.read(&mut chunk).await.expect("read SSE response");
        assert!(n > 0, "SSE stream closed before headers");
        buffer.extend_from_slice(&chunk[..n]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }

    let (status, headers, body) = parse_http_status_and_headers(&buffer);
    assert_eq!(status, 200);
    assert!(
        headers.to_ascii_lowercase().contains("content-type: text/event-stream"),
        "expected SSE content type, got headers: {headers}"
    );
    (stream, body)
}

async fn next_sse_data(
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    timeout_ms: u64,
) -> String {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if let Some((frame_end, delimiter_len)) = next_sse_frame_boundary(buffered) {
            let mut frame = buffered.drain(..frame_end + delimiter_len).collect::<Vec<u8>>();
            frame.truncate(frame_end);
            let text = String::from_utf8_lossy(&frame).replace("\r\n", "\n");
            if let Some(data) = text.strip_prefix("data: ") {
                return data.to_string();
            }
            continue;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for SSE frame"
        );
        let mut chunk = [0_u8; 4096];
        let n = stream.read(&mut chunk).await.expect("read SSE frame");
        assert!(n > 0, "SSE stream closed while waiting for frame");
        buffered.extend_from_slice(&chunk[..n]);
    }
}

fn next_sse_frame_boundary(buffered: &[u8]) -> Option<(usize, usize)> {
    let lf = buffered.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2));
    let crlf = buffered
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4));

    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

async fn wait_for_sse_clients(addr: SocketAddr, expected: u64, timeout_ms: u64) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        let (_, health) = http_get_json(addr, "/api/health").await;
        if health["sse_clients"].as_u64() == Some(expected) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("health did not report sse_clients={expected} within {timeout_ms}ms");
}

#[tokio::test]
async fn invariant_event_persistence_and_dedup() {
    let runtime = TestRuntime::start().await;

    let event = json!({
        "event_id": "desktop-invariant-dedup-1",
        "session_id": "desktop-invariant-session-1",
        "agent_type": "codex",
        "event_type": "llm_request",
        "tokens_in": 12,
        "tokens_out": 34
    });

    let (status1, body1) = http_post_json(runtime.addr, "/api/events", &event).await;
    assert_eq!(status1, 201);
    assert_eq!(body1["received"], 1);
    assert_eq!(body1["duplicates"], 0);

    let (status2, body2) = http_post_json(runtime.addr, "/api/events", &event).await;
    assert_eq!(status2, 200);
    assert_eq!(body2["received"], 0);
    assert_eq!(body2["duplicates"], 1);

    let (stats_status, stats) = http_get_json(runtime.addr, "/api/stats").await;
    assert_eq!(stats_status, 200);
    assert_eq!(stats["total_events"], 1);
    assert_eq!(stats["total_sessions"], 1);

    runtime.stop().await;
}

#[tokio::test]
async fn invariant_session_end_lifecycle() {
    let runtime = TestRuntime::start().await;

    let claude_end = json!({
        "session_id": "desktop-invariant-claude",
        "agent_type": "claude_code",
        "event_type": "session_end"
    });
    let codex_end = json!({
        "session_id": "desktop-invariant-codex",
        "agent_type": "codex",
        "event_type": "session_end"
    });

    let (c_status, _) = http_post_json(runtime.addr, "/api/events", &claude_end).await;
    let (x_status, _) = http_post_json(runtime.addr, "/api/events", &codex_end).await;
    assert_eq!(c_status, 201);
    assert_eq!(x_status, 201);

    let (sessions_status, sessions) = http_get_json(runtime.addr, "/api/sessions?limit=20").await;
    assert_eq!(sessions_status, 200);
    let list = sessions["sessions"].as_array().expect("sessions array");

    let claude = list
        .iter()
        .find(|s| s["id"] == "desktop-invariant-claude")
        .expect("claude session should exist");
    let codex = list
        .iter()
        .find(|s| s["id"] == "desktop-invariant-codex")
        .expect("codex session should exist");

    assert_eq!(claude["status"], "idle");
    assert_eq!(codex["status"], "ended");

    runtime.stop().await;
}

#[tokio::test]
async fn invariant_sse_delivery_and_client_count() {
    let runtime = TestRuntime::start().await;

    let (mut sse_stream, mut sse_buf) = open_sse(runtime.addr).await;
    let connected = next_sse_data(&mut sse_stream, &mut sse_buf, 2_000).await;
    let connected_json: Value = serde_json::from_str(&connected).expect("connected json");
    assert_eq!(connected_json["type"], "connected");

    wait_for_sse_clients(runtime.addr, 1, 2_000).await;

    let event = json!({
        "session_id": "desktop-invariant-sse",
        "agent_type": "claude_code",
        "event_type": "tool_use"
    });
    let (status, _) = http_post_json(runtime.addr, "/api/events", &event).await;
    assert_eq!(status, 201);

    let broadcast = next_sse_data(&mut sse_stream, &mut sse_buf, 2_000).await;
    let broadcast_json: Value = serde_json::from_str(&broadcast).expect("broadcast json");
    assert_eq!(broadcast_json["type"], "event");
    assert_eq!(
        broadcast_json["payload"]["session_id"],
        "desktop-invariant-sse"
    );

    drop(sse_stream);
    wait_for_sse_clients(runtime.addr, 0, 2_000).await;

    runtime.stop().await;
}
