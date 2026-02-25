use std::env;
use std::path::PathBuf;

/// Runtime configuration, mirroring TypeScript env var names where possible.
pub struct Config {
    pub port: u16,
    pub host: String,
    pub db_path: PathBuf,
    pub max_payload_kb: usize,
    pub session_timeout_minutes: u64,
    pub max_feed: usize,
    pub stats_interval_ms: u64,
    pub max_sse_clients: usize,
    pub sse_heartbeat_ms: u64,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: parse_env_u16("AGENTMONITOR_RUST_PORT", 3142),
            host: env::var("AGENTMONITOR_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            db_path: env::var("AGENTMONITOR_RUST_DB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("./data/agentmonitor-rs.db")),
            max_payload_kb: parse_env("AGENTMONITOR_MAX_PAYLOAD_KB", 10),
            session_timeout_minutes: parse_env("AGENTMONITOR_SESSION_TIMEOUT", 5),
            max_feed: parse_env("AGENTMONITOR_MAX_FEED", 200),
            stats_interval_ms: parse_env("AGENTMONITOR_STATS_INTERVAL", 5000),
            max_sse_clients: parse_env("AGENTMONITOR_MAX_SSE_CLIENTS", 50),
            sse_heartbeat_ms: parse_env("AGENTMONITOR_SSE_HEARTBEAT_MS", 30000),
        }
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn parse_env<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn parse_env_u16(key: &str, default: u16) -> u16 {
    parse_env(key, default)
}
