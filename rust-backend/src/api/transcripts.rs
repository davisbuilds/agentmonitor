use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Serialize;
use serde_json::Value;

use crate::db::queries::{self, TranscriptEvent};
use crate::state::AppState;

#[derive(Debug, Serialize)]
struct TranscriptResponse {
    session_id: String,
    entries: Vec<TranscriptEntry>,
}

#[derive(Debug, Serialize)]
struct TranscriptError {
    error: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptEntry {
    role: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens_in: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens_out: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<i64>,
    timestamp: String,
}

fn map_role(event_type: &str) -> String {
    match event_type {
        "session_start" | "session_end" => "system".to_string(),
        "user_prompt" => "user".to_string(),
        "tool_use" => "tool".to_string(),
        "error" => "assistant".to_string(),
        _ => "assistant".to_string(),
    }
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        _ => None,
    }
}

fn extract_detail(event: &TranscriptEvent) -> Option<String> {
    let meta: Value = serde_json::from_str(&event.metadata).ok()?;
    let meta_obj = meta.as_object()?;

    if event.event_type == "user_prompt"
        && let Some(v) = meta_obj.get("message").and_then(scalar_to_string)
    {
        return Some(v);
    }
    if let Some(v) = meta_obj.get("content_preview").and_then(scalar_to_string) {
        return Some(v);
    }
    if let Some(v) = meta_obj.get("command").and_then(scalar_to_string) {
        return Some(v);
    }
    if let Some(v) = meta_obj.get("file_path").and_then(scalar_to_string) {
        return Some(v);
    }
    if let Some(v) = meta_obj.get("pattern").and_then(scalar_to_string) {
        return Some(v);
    }
    if let Some(v) = meta_obj.get("query").and_then(scalar_to_string) {
        return Some(v);
    }
    if let Some(err_val) = meta_obj.get("error") {
        if let Some(v) = scalar_to_string(err_val) {
            return Some(v);
        }
        if let Some(v) = err_val
            .as_object()
            .and_then(|obj| obj.get("message"))
            .and_then(scalar_to_string)
        {
            return Some(v);
        }
    }
    if let Some(v) = meta_obj.get("diff_preview").and_then(scalar_to_string) {
        return Some(v);
    }

    None
}

fn to_entry(event: TranscriptEvent) -> TranscriptEntry {
    let detail = extract_detail(&event);
    TranscriptEntry {
        role: map_role(&event.event_type),
        entry_type: event.event_type.clone(),
        tool_name: event.tool_name,
        detail,
        status: if event.status != "success" {
            Some(event.status)
        } else {
            None
        },
        model: event.model,
        tokens_in: if event.tokens_in > 0 {
            Some(event.tokens_in)
        } else {
            None
        },
        tokens_out: if event.tokens_out > 0 {
            Some(event.tokens_out)
        } else {
            None
        },
        cost_usd: event.cost_usd.filter(|v| *v > 0.0),
        duration_ms: event.duration_ms,
        timestamp: event.client_timestamp.unwrap_or(event.created_at),
    }
}

/// GET /api/sessions/:id/transcript
pub async fn session_transcript_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match queries::get_session_transcript(&db, &session_id) {
        Ok(events) if events.is_empty() => (
            StatusCode::NOT_FOUND,
            Json(TranscriptError {
                error: "No transcript data for this session",
            }),
        )
            .into_response(),
        Ok(events) => {
            let entries = events.into_iter().map(to_entry).collect();
            (
                StatusCode::OK,
                Json(TranscriptResponse {
                    session_id,
                    entries,
                }),
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}
