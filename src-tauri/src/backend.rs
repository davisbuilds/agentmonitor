use std::fmt;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::runtime_host::{RuntimeHost, RuntimeHostError, start_with_config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct EmbeddedBackend {
    runtime: Option<RuntimeHost>,
    local_addr: SocketAddr,
}

impl EmbeddedBackend {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn shutdown(mut self) -> Result<(), BackendStartupError> {
        if let Some(runtime) = self.runtime.take() {
            runtime
                .stop()
                .await
                .map_err(|err| BackendStartupError::Shutdown(format!("{err}")))?;
        }
        Ok(())
    }
}

pub struct EmbeddedBackendState {
    backend: Mutex<Option<EmbeddedBackend>>,
}

impl EmbeddedBackendState {
    pub fn new(backend: EmbeddedBackend) -> Self {
        Self {
            backend: Mutex::new(Some(backend)),
        }
    }

    pub fn shutdown_blocking(&self) -> Result<(), BackendStartupError> {
        let backend = self
            .backend
            .lock()
            .map_err(|_| BackendStartupError::Shutdown("embedded backend state lock poisoned".into()))?
            .take();

        if let Some(backend) = backend {
            tauri::async_runtime::block_on(backend.shutdown())?;
        }

        Ok(())
    }
}

#[derive(Debug)]
pub enum BackendStartupError {
    Bind(String),
    Start(String),
    Health(String),
    Shutdown(String),
}

impl fmt::Display for BackendStartupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bind(msg) => write!(f, "{msg}"),
            Self::Start(msg) => write!(f, "{msg}"),
            Self::Health(msg) => write!(f, "{msg}"),
            Self::Shutdown(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for BackendStartupError {}

pub async fn start_embedded_backend() -> Result<EmbeddedBackend, BackendStartupError> {
    start_embedded_backend_with_config(Config::from_env()).await
}

pub async fn start_embedded_backend_with_config(
    config: Config,
) -> Result<EmbeddedBackend, BackendStartupError> {
    let runtime = start_with_config(config).await.map_err(map_start_error)?;
    let local_addr = runtime.local_addr();

    if let Err(err) = wait_for_health(local_addr, Duration::from_secs(2)).await {
        // Ensure partially-started runtime does not leak on readiness failure.
        let _ = runtime.stop().await;
        return Err(err);
    }

    Ok(EmbeddedBackend {
        runtime: Some(runtime),
        local_addr,
    })
}

fn map_start_error(err: RuntimeHostError) -> BackendStartupError {
    match err {
        RuntimeHostError::Bind(inner) => {
            BackendStartupError::Bind(format!("Failed to bind embedded backend: {inner}"))
        }
        other => BackendStartupError::Start(format!("Failed to start embedded backend: {other}")),
    }
}

async fn wait_for_health(addr: SocketAddr, timeout: Duration) -> Result<(), BackendStartupError> {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if let Some(200) = health_status(addr).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    Err(BackendStartupError::Health(format!(
        "Embedded backend health check timed out at {addr} after {}ms",
        timeout.as_millis()
    )))
}

async fn health_status(addr: SocketAddr) -> Option<u16> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        addr
    );
    stream.write_all(request.as_bytes()).await.ok()?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.ok()?;
    let response = String::from_utf8_lossy(&response);
    let status_line = response.lines().next()?;
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
}
