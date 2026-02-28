use std::fmt;
use std::net::SocketAddr;

use crate::config::Config;
use crate::runtime_host::{RuntimeHost, RuntimeHostError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeEndpoint {
    local_addr: SocketAddr,
    base_url: String,
}

impl RuntimeEndpoint {
    fn from_local_addr(local_addr: SocketAddr) -> Self {
        Self {
            local_addr,
            base_url: format!("http://{local_addr}"),
        }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

#[derive(Debug)]
pub enum RuntimeContractError {
    Bind(std::io::Error),
    Start(String),
    Stop(String),
}

impl fmt::Display for RuntimeContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bind(err) => write!(f, "bind failed: {err}"),
            Self::Start(msg) => write!(f, "runtime startup failed: {msg}"),
            Self::Stop(msg) => write!(f, "runtime shutdown failed: {msg}"),
        }
    }
}

impl std::error::Error for RuntimeContractError {}

pub struct RuntimeContract {
    host: Option<RuntimeHost>,
    endpoint: RuntimeEndpoint,
}

impl RuntimeContract {
    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.endpoint.local_addr()
    }

    pub fn base_url(&self) -> &str {
        self.endpoint.base_url()
    }

    pub async fn shutdown(mut self) -> Result<(), RuntimeContractError> {
        if let Some(host) = self.host.take() {
            host.stop()
                .await
                .map_err(|err| RuntimeContractError::Stop(err.to_string()))?;
        }
        Ok(())
    }
}

pub async fn start_with_config(config: Config) -> Result<RuntimeContract, RuntimeContractError> {
    let host = crate::runtime_host::start_with_config(config)
        .await
        .map_err(map_start_error)?;
    let endpoint = RuntimeEndpoint::from_local_addr(host.local_addr());
    Ok(RuntimeContract {
        host: Some(host),
        endpoint,
    })
}

fn map_start_error(err: RuntimeHostError) -> RuntimeContractError {
    match err {
        RuntimeHostError::Bind(inner) => RuntimeContractError::Bind(inner),
        other => RuntimeContractError::Start(other.to_string()),
    }
}
