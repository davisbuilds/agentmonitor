use std::env;
use std::path::PathBuf;

#[derive(Clone)]
pub enum UsageLimitType {
    Tokens,
    Cost,
}

impl UsageLimitType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Tokens => "tokens",
            Self::Cost => "cost",
        }
    }
}

#[derive(Clone)]
pub struct AgentUsageConfig {
    pub limit_type: UsageLimitType,
    pub session_window_hours: i64,
    pub session_limit: f64,
    pub extended_window_hours: i64,
    pub extended_limit: f64,
}

#[derive(Clone)]
pub struct UsageMonitorConfig {
    pub claude_code: AgentUsageConfig,
    pub codex: AgentUsageConfig,
    pub default: AgentUsageConfig,
}

impl UsageMonitorConfig {
    pub fn for_agent(&self, agent_type: &str) -> &AgentUsageConfig {
        match agent_type {
            "claude_code" => &self.claude_code,
            "codex" => &self.codex,
            _ => &self.default,
        }
    }
}

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
    pub auto_import_interval_minutes: u64,
    pub usage_monitor: UsageMonitorConfig,
}

impl Config {
    pub fn from_env() -> Self {
        let default_window_hours = parse_env_i64_min("AGENTMONITOR_SESSION_WINDOW_HOURS", 5, 1);

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
            auto_import_interval_minutes: parse_env("AGENTMONITOR_AUTO_IMPORT_MINUTES", 10),
            usage_monitor: UsageMonitorConfig {
                claude_code: AgentUsageConfig {
                    limit_type: UsageLimitType::Tokens,
                    session_window_hours: parse_env_i64_min(
                        "AGENTMONITOR_SESSION_WINDOW_HOURS_CLAUDE_CODE",
                        default_window_hours,
                        1,
                    ),
                    session_limit: parse_env_f64_min(
                        "AGENTMONITOR_SESSION_TOKEN_LIMIT_CLAUDE_CODE",
                        44000.0,
                        0.0,
                    ),
                    extended_window_hours: parse_env_i64_min(
                        "AGENTMONITOR_EXTENDED_WINDOW_HOURS_CLAUDE_CODE",
                        24,
                        1,
                    ),
                    extended_limit: parse_env_f64_min(
                        "AGENTMONITOR_EXTENDED_TOKEN_LIMIT_CLAUDE_CODE",
                        0.0,
                        0.0,
                    ),
                },
                codex: AgentUsageConfig {
                    limit_type: UsageLimitType::Cost,
                    session_window_hours: parse_env_i64_min(
                        "AGENTMONITOR_SESSION_WINDOW_HOURS_CODEX",
                        default_window_hours,
                        1,
                    ),
                    session_limit: parse_env_f64_min(
                        "AGENTMONITOR_SESSION_COST_LIMIT_CODEX",
                        500.0,
                        0.0,
                    ),
                    extended_window_hours: parse_env_i64_min(
                        "AGENTMONITOR_EXTENDED_WINDOW_HOURS_CODEX",
                        168,
                        1,
                    ),
                    extended_limit: parse_env_f64_min(
                        "AGENTMONITOR_EXTENDED_COST_LIMIT_CODEX",
                        1500.0,
                        0.0,
                    ),
                },
                default: AgentUsageConfig {
                    limit_type: UsageLimitType::Tokens,
                    session_window_hours: default_window_hours,
                    session_limit: 0.0,
                    extended_window_hours: 24,
                    extended_limit: 0.0,
                },
            },
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

fn parse_env_i64_min(key: &str, default: i64, min: i64) -> i64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= min)
        .unwrap_or(default)
}

fn parse_env_f64_min(key: &str, default: f64, min: f64) -> f64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v >= min)
        .unwrap_or(default)
}
