use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::backend;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub mode: String,
    pub backend_transport: String,
    pub ipc_enabled: bool,
    pub backend_base_url: String,
    pub backend_addr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHealthSnapshot {
    pub http_status: u16,
    pub status: String,
    pub uptime: u64,
    pub db_size_bytes: u64,
    pub sse_clients: usize,
}

#[derive(Debug, Deserialize)]
struct BackendHealthResponse {
    status: String,
    uptime: u64,
    db_size_bytes: u64,
    sse_clients: usize,
}

pub fn runtime_status_from_state(
    state: &backend::EmbeddedBackendState,
) -> Result<DesktopRuntimeStatus, String> {
    let snapshot = state.snapshot()?;
    Ok(DesktopRuntimeStatus {
        mode: "internal-first-http-plus-ipc".to_string(),
        backend_transport: "http".to_string(),
        ipc_enabled: true,
        backend_base_url: snapshot.base_url,
        backend_addr: snapshot.local_addr.to_string(),
    })
}

pub async fn desktop_health_from_state(
    state: &backend::EmbeddedBackendState,
) -> Result<DesktopHealthSnapshot, String> {
    let snapshot = state.snapshot()?;
    fetch_health(snapshot.local_addr).await
}

#[tauri::command]
pub fn desktop_runtime_status(
    state: tauri::State<'_, backend::EmbeddedBackendState>,
) -> Result<DesktopRuntimeStatus, String> {
    runtime_status_from_state(&state)
}

#[tauri::command]
pub async fn desktop_health(
    state: tauri::State<'_, backend::EmbeddedBackendState>,
) -> Result<DesktopHealthSnapshot, String> {
    desktop_health_from_state(&state).await
}

async fn fetch_health(addr: std::net::SocketAddr) -> Result<DesktopHealthSnapshot, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|err| format!("failed to connect to embedded backend health endpoint: {err}"))?;
    let request = format!("GET /api/health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|err| format!("failed to write embedded backend health request: {err}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|err| format!("failed to read embedded backend health response: {err}"))?;

    let (http_status, body) = split_http_response(&response)?;
    let parsed: BackendHealthResponse = serde_json::from_slice(body)
        .map_err(|err| format!("failed to decode embedded backend health JSON: {err}"))?;

    Ok(DesktopHealthSnapshot {
        http_status,
        status: parsed.status,
        uptime: parsed.uptime,
        db_size_bytes: parsed.db_size_bytes,
        sse_clients: parsed.sse_clients,
    })
}

fn split_http_response(raw: &[u8]) -> Result<(u16, &[u8]), String> {
    let split_at = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "invalid HTTP response from embedded backend".to_string())?
        + 4;
    let (headers, body) = raw.split_at(split_at);
    let headers = String::from_utf8_lossy(headers);
    let status_line = headers
        .lines()
        .next()
        .ok_or_else(|| "missing HTTP status line".to_string())?;
    let http_status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("invalid HTTP status line: {status_line}"))?;
    Ok((http_status, body))
}

#[cfg(test)]
mod tests {
    use super::split_http_response;

    #[test]
    fn split_http_response_parses_status_and_body() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}";
        let (status, body) = split_http_response(response).expect("response should parse");
        assert_eq!(status, 200);
        assert_eq!(body, b"{\"status\":\"ok\"}");
    }
}
