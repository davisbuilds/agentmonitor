use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub const DEFAULT_BIND_HOST: &str = "127.0.0.1";
pub const DEFAULT_RUST_PORT: u16 = 3142;

type EnvMap = HashMap<String, String>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexLiveMode {
    OtelOnly,
    Exporter,
}

impl CodexLiveMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OtelOnly => "otel-only",
            Self::Exporter => "exporter",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InsightsProvider {
    OpenAi,
    Anthropic,
    Gemini,
}

impl InsightsProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveCaptureConfig {
    pub prompts: bool,
    pub reasoning: bool,
    pub tool_arguments: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveConfig {
    pub enabled: bool,
    pub codex_mode: CodexLiveMode,
    pub capture: LiveCaptureConfig,
    pub diff_payload_max_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncConfig {
    pub exclude_patterns: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsightProviderConfig {
    pub api_key: Option<String>,
    pub model: String,
    pub base_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsightsProviderConfigs {
    pub openai: InsightProviderConfig,
    pub anthropic: InsightProviderConfig,
    pub gemini: InsightProviderConfig,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsightsConfig {
    pub provider: InsightsProvider,
    pub providers: InsightsProviderConfigs,
}

impl InsightsConfig {
    pub fn active_provider(&self) -> &InsightProviderConfig {
        match self.provider {
            InsightsProvider::OpenAi => &self.providers.openai,
            InsightsProvider::Anthropic => &self.providers.anthropic,
            InsightsProvider::Gemini => &self.providers.gemini,
        }
    }
}

/// Runtime configuration, mirroring TypeScript env var names where possible.
pub struct Config {
    pub port: u16,
    pub host: String,
    pub db_path: PathBuf,
    pub ui_dir: PathBuf,
    pub app_ui_dir: PathBuf,
    pub max_payload_kb: usize,
    pub session_timeout_minutes: u64,
    pub max_feed: usize,
    pub stats_interval_ms: u64,
    pub max_sse_clients: usize,
    pub sse_heartbeat_ms: u64,
    pub auto_import_interval_minutes: u64,
    pub live: LiveConfig,
    pub sync: SyncConfig,
    pub insights: InsightsConfig,
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_env_map(&std::env::vars().collect())
    }

    pub fn from_env_map(env: &HashMap<String, String>) -> Self {
        Self {
            port: parse_env_u16(env, "AGENTMONITOR_RUST_PORT", DEFAULT_RUST_PORT),
            host: env_trimmed(env, "AGENTMONITOR_HOST")
                .unwrap_or_else(|| DEFAULT_BIND_HOST.to_string()),
            db_path: env_trimmed(env, "AGENTMONITOR_RUST_DB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("./data/agentmonitor-rs.db")),
            ui_dir: env_trimmed(env, "AGENTMONITOR_UI_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(default_ui_dir),
            app_ui_dir: env_trimmed(env, "AGENTMONITOR_APP_UI_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(default_app_ui_dir),
            max_payload_kb: parse_env(env, "AGENTMONITOR_MAX_PAYLOAD_KB", 10),
            session_timeout_minutes: parse_env(env, "AGENTMONITOR_SESSION_TIMEOUT", 5),
            max_feed: parse_env(env, "AGENTMONITOR_MAX_FEED", 200),
            stats_interval_ms: parse_env(env, "AGENTMONITOR_STATS_INTERVAL", 5000),
            max_sse_clients: parse_env(env, "AGENTMONITOR_MAX_SSE_CLIENTS", 50),
            sse_heartbeat_ms: parse_env(env, "AGENTMONITOR_SSE_HEARTBEAT_MS", 30000),
            auto_import_interval_minutes: parse_env(env, "AGENTMONITOR_AUTO_IMPORT_MINUTES", 10),
            live: LiveConfig {
                enabled: parse_env_bool(env, "AGENTMONITOR_ENABLE_LIVE_TAB", true),
                codex_mode: parse_codex_live_mode(env_trimmed(env, "AGENTMONITOR_CODEX_LIVE_MODE")),
                capture: LiveCaptureConfig {
                    prompts: parse_env_bool(env, "AGENTMONITOR_LIVE_CAPTURE_PROMPTS", true),
                    reasoning: parse_env_bool(env, "AGENTMONITOR_LIVE_CAPTURE_REASONING", true),
                    tool_arguments: parse_env_bool(
                        env,
                        "AGENTMONITOR_LIVE_CAPTURE_TOOL_ARGUMENTS",
                        true,
                    ),
                },
                diff_payload_max_bytes: parse_env(
                    env,
                    "AGENTMONITOR_LIVE_DIFF_PAYLOAD_MAX_BYTES",
                    32768,
                ),
            },
            sync: SyncConfig {
                exclude_patterns: parse_env_list(env, "AGENTMONITOR_SYNC_EXCLUDE_PATTERNS"),
            },
            insights: InsightsConfig {
                provider: parse_insights_provider(env_trimmed(
                    env,
                    "AGENTMONITOR_INSIGHTS_PROVIDER",
                )),
                providers: InsightsProviderConfigs {
                    openai: InsightProviderConfig {
                        api_key: env_trimmed(env, "AGENTMONITOR_OPENAI_API_KEY")
                            .or_else(|| env_trimmed(env, "OPENAI_API_KEY")),
                        model: first_present(
                            env,
                            &[
                                "AGENTMONITOR_OPENAI_INSIGHTS_MODEL",
                                "AGENTMONITOR_INSIGHTS_OPENAI_MODEL",
                                "AGENTMONITOR_INSIGHTS_MODEL",
                            ],
                            "gpt-5-mini",
                        ),
                        base_url: first_present(
                            env,
                            &["AGENTMONITOR_OPENAI_BASE_URL"],
                            "https://api.openai.com/v1",
                        )
                        .trim_end_matches('/')
                        .to_string(),
                    },
                    anthropic: InsightProviderConfig {
                        api_key: env_trimmed(env, "AGENTMONITOR_ANTHROPIC_API_KEY")
                            .or_else(|| env_trimmed(env, "ANTHROPIC_API_KEY")),
                        model: first_present(
                            env,
                            &[
                                "AGENTMONITOR_ANTHROPIC_INSIGHTS_MODEL",
                                "AGENTMONITOR_INSIGHTS_ANTHROPIC_MODEL",
                            ],
                            "claude-sonnet-4-5",
                        ),
                        base_url: first_present(
                            env,
                            &["AGENTMONITOR_ANTHROPIC_BASE_URL"],
                            "https://api.anthropic.com/v1",
                        )
                        .trim_end_matches('/')
                        .to_string(),
                    },
                    gemini: InsightProviderConfig {
                        api_key: env_trimmed(env, "AGENTMONITOR_GEMINI_API_KEY")
                            .or_else(|| env_trimmed(env, "GEMINI_API_KEY"))
                            .or_else(|| env_trimmed(env, "GOOGLE_API_KEY")),
                        model: first_present(
                            env,
                            &[
                                "AGENTMONITOR_GEMINI_INSIGHTS_MODEL",
                                "AGENTMONITOR_INSIGHTS_GEMINI_MODEL",
                            ],
                            "gemini-2.5-flash",
                        ),
                        base_url: first_present(
                            env,
                            &["AGENTMONITOR_GEMINI_BASE_URL"],
                            "https://generativelanguage.googleapis.com/v1beta",
                        )
                        .trim_end_matches('/')
                        .to_string(),
                    },
                },
            },
        }
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub fn apply_bind_override(mut self, host: Option<String>, port: Option<u16>) -> Self {
        if let Some(host) = host {
            self.host = host;
        }
        if let Some(port) = port {
            self.port = port;
        }
        self
    }
}

fn parse_env<T: std::str::FromStr>(env: &EnvMap, key: &str, default: T) -> T {
    env_trimmed(env, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn parse_env_u16(env: &EnvMap, key: &str, default: u16) -> u16 {
    parse_env(env, key, default)
}

fn parse_env_bool(env: &EnvMap, key: &str, default: bool) -> bool {
    match env_trimmed(env, key) {
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        None => default,
    }
}

fn parse_env_list(env: &EnvMap, key: &str) -> Vec<String> {
    let Some(value) = env_trimmed(env, key) else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .filter_map(|item| {
            let item = item.to_string();
            if seen.insert(item.clone()) {
                Some(item)
            } else {
                None
            }
        })
        .collect()
}

fn parse_codex_live_mode(value: Option<String>) -> CodexLiveMode {
    match value.as_deref() {
        Some("exporter") => CodexLiveMode::Exporter,
        _ => CodexLiveMode::OtelOnly,
    }
}

fn parse_insights_provider(value: Option<String>) -> InsightsProvider {
    match value
        .as_deref()
        .map(|item| item.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("anthropic") => InsightsProvider::Anthropic,
        Some("gemini") => InsightsProvider::Gemini,
        _ => InsightsProvider::OpenAi,
    }
}

fn first_present(env: &EnvMap, keys: &[&str], fallback: &str) -> String {
    keys.iter()
        .find_map(|key| env_trimmed(env, key))
        .unwrap_or_else(|| fallback.to_string())
}

fn env_trimmed(env: &EnvMap, key: &str) -> Option<String> {
    env.get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_ui_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR points to rust-backend/ at compile time.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|repo_root| repo_root.join("public"))
        .unwrap_or_else(|| PathBuf::from("./public"))
}

fn default_app_ui_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|repo_root| repo_root.join("frontend").join("dist"))
        .unwrap_or_else(|| PathBuf::from("./frontend/dist"))
}
