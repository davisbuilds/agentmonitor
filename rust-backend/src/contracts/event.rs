use serde::{Deserialize, Serialize};

/// Known event types — mirrors EVENT_TYPES in TypeScript event-contract.ts.
pub const EVENT_TYPES: &[&str] = &[
    "tool_use",
    "session_start",
    "session_end",
    "error",
    "llm_request",
    "llm_response",
    "response",
    "file_change",
    "git_commit",
    "plan_step",
    "user_prompt",
];

/// Known event statuses — mirrors EVENT_STATUSES in TypeScript.
pub const EVENT_STATUSES: &[&str] = &["success", "error", "timeout"];

/// Known event sources — mirrors EVENT_SOURCES in TypeScript.
pub const EVENT_SOURCES: &[&str] = &["api", "hook", "otel", "import"];

/// Validated, normalized event ready for database insertion.
#[derive(Debug, Clone, Serialize)]
pub struct NormalizedEvent {
    pub event_id: Option<String>,
    pub session_id: String,
    pub agent_type: String,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub status: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub branch: Option<String>,
    pub project: Option<String>,
    pub duration_ms: Option<i64>,
    pub metadata: serde_json::Value,
    pub client_timestamp: Option<String>,
    pub model: Option<String>,
    pub cost_usd: Option<f64>,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub source: Option<String>,
}

/// Raw ingest payload — loosely typed for validation.
#[derive(Debug, Deserialize)]
pub struct RawIngestEvent {
    pub event_id: Option<serde_json::Value>,
    pub session_id: Option<serde_json::Value>,
    pub agent_type: Option<serde_json::Value>,
    pub event_type: Option<serde_json::Value>,
    pub tool_name: Option<serde_json::Value>,
    pub status: Option<serde_json::Value>,
    pub tokens_in: Option<serde_json::Value>,
    pub tokens_out: Option<serde_json::Value>,
    pub branch: Option<serde_json::Value>,
    pub project: Option<serde_json::Value>,
    pub duration_ms: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
    pub client_timestamp: Option<serde_json::Value>,
    pub model: Option<serde_json::Value>,
    pub cost_usd: Option<serde_json::Value>,
    pub cache_read_tokens: Option<serde_json::Value>,
    pub cache_write_tokens: Option<serde_json::Value>,
    pub source: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum NormalizeResult {
    Ok { event: NormalizedEvent },
    Err { errors: Vec<ValidationError> },
}

impl NormalizeResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, NormalizeResult::Ok { .. })
    }

    pub fn unwrap_event(self) -> NormalizedEvent {
        match self {
            NormalizeResult::Ok { event } => event,
            NormalizeResult::Err { errors } => {
                panic!("called unwrap_event on Err: {:?}", errors)
            }
        }
    }

    pub fn unwrap_errors(self) -> Vec<ValidationError> {
        match self {
            NormalizeResult::Err { errors } => errors,
            NormalizeResult::Ok { .. } => panic!("called unwrap_errors on Ok"),
        }
    }
}
