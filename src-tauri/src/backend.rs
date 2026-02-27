use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::runtime_contract::{
    start_with_config as start_runtime_with_config, RuntimeContract, RuntimeContractError,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct EmbeddedBackend {
    runtime: Option<RuntimeContract>,
    local_addr: SocketAddr,
    base_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddedBackendSnapshot {
    pub local_addr: SocketAddr,
    pub base_url: String,
}

impl EmbeddedBackend {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn shutdown(mut self) -> Result<(), BackendStartupError> {
        if let Some(runtime) = self.runtime.take() {
            runtime
                .shutdown()
                .await
                .map_err(|err| BackendStartupError::Shutdown(format!("{err}")))?;
        }
        Ok(())
    }

    fn snapshot(&self) -> EmbeddedBackendSnapshot {
        EmbeddedBackendSnapshot {
            local_addr: self.local_addr,
            base_url: self.base_url.clone(),
        }
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
        tauri::async_runtime::block_on(self.shutdown_async())
    }

    pub async fn shutdown_async(&self) -> Result<(), BackendStartupError> {
        let backend = self
            .backend
            .lock()
            .map_err(|_| {
                BackendStartupError::Shutdown("embedded backend state lock poisoned".into())
            })?
            .take();

        if let Some(backend) = backend {
            backend.shutdown().await?;
        }

        Ok(())
    }

    pub fn snapshot(&self) -> Result<EmbeddedBackendSnapshot, String> {
        let guard = self
            .backend
            .lock()
            .map_err(|_| "embedded backend state lock poisoned".to_string())?;
        let backend = guard
            .as_ref()
            .ok_or_else(|| "embedded backend not available".to_string())?;
        Ok(backend.snapshot())
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DesktopBindOverrides {
    pub host: Option<String>,
    pub port: Option<u16>,
}

impl DesktopBindOverrides {
    pub fn from_env() -> Self {
        let host = std::env::var("AGENTMONITOR_DESKTOP_HOST")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let port = std::env::var("AGENTMONITOR_DESKTOP_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok());
        Self { host, port }
    }
}

pub fn apply_desktop_bind_overrides(config: Config, overrides: DesktopBindOverrides) -> Config {
    config.apply_bind_override(overrides.host, overrides.port)
}

pub fn apply_desktop_runtime_overrides(
    mut config: Config,
    bind_overrides: DesktopBindOverrides,
    app_data_dir: Option<&Path>,
) -> Result<Config, BackendStartupError> {
    config = apply_desktop_bind_overrides(config, bind_overrides);

    if let Some(app_data_dir) = app_data_dir {
        if config.db_path.is_relative() {
            config.db_path = app_data_dir.join(&config.db_path);
        }
        if let Some(parent) = config.db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                BackendStartupError::Start(format!(
                    "Failed to prepare embedded backend database directory ({}): {err}",
                    parent.display()
                ))
            })?;
        }
    }

    Ok(config)
}

fn desktop_runtime_config_from_env(app_data_dir: Option<&Path>) -> Result<Config, BackendStartupError> {
    let base = Config::from_env();
    let overrides = DesktopBindOverrides::from_env();
    apply_desktop_runtime_overrides(base, overrides, app_data_dir)
}

pub async fn start_embedded_backend() -> Result<EmbeddedBackend, BackendStartupError> {
    start_embedded_backend_with_app_data_dir(None).await
}

pub async fn start_embedded_backend_with_app_data_dir(
    app_data_dir: Option<PathBuf>,
) -> Result<EmbeddedBackend, BackendStartupError> {
    let config = desktop_runtime_config_from_env(app_data_dir.as_deref())?;
    start_embedded_backend_with_config(config).await
}

pub async fn start_embedded_backend_with_config(
    config: Config,
) -> Result<EmbeddedBackend, BackendStartupError> {
    let runtime = start_runtime_with_config(config)
        .await
        .map_err(map_start_error)?;
    let local_addr = runtime.local_addr();
    let base_url = runtime.base_url().to_string();

    if let Err(err) = wait_for_health(local_addr, Duration::from_secs(2)).await {
        // Ensure partially-started runtime does not leak on readiness failure.
        let _ = runtime.shutdown().await;
        return Err(err);
    }

    Ok(EmbeddedBackend {
        runtime: Some(runtime),
        local_addr,
        base_url,
    })
}

fn map_start_error(err: RuntimeContractError) -> BackendStartupError {
    match err {
        RuntimeContractError::Bind(inner) => {
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
