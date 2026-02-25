use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Serialize;
use serde_json::Value;
use tracing::warn;

use crate::contracts::validation::normalize_from_value;
use crate::contracts::event::{NormalizeResult, ValidationError};
use crate::db::queries::{self, InsertEventParams};
use crate::state::AppState;
use crate::util::truncate::truncate_metadata;

// --- Response types ---

#[derive(Serialize)]
struct IngestResponse {
    received: usize,
    ids: Vec<i64>,
    duplicates: usize,
}

#[derive(Serialize)]
struct IngestErrorResponse {
    error: &'static str,
    details: Vec<ValidationError>,
}

#[derive(Serialize)]
struct BatchRejection {
    index: usize,
    errors: Vec<String>,
}

#[derive(Serialize)]
struct BatchResponse {
    received: usize,
    ids: Vec<i64>,
    duplicates: usize,
    rejected: Vec<BatchRejection>,
}

#[derive(Serialize)]
struct BatchFormatError {
    error: &'static str,
}

// --- Handlers ---

/// POST /api/events — single event ingest.
pub async fn ingest_single(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let result = normalize_from_value(body);

    match result {
        NormalizeResult::Err { errors } => {
            (StatusCode::BAD_REQUEST, Json(Value::from(serde_json::to_value(
                IngestErrorResponse {
                    error: "Invalid event payload",
                    details: errors,
                },
            ).unwrap()))).into_response()
        }
        NormalizeResult::Ok { event } => {
            let max_kb = state.config.max_payload_kb;
            let truncated = truncate_metadata(&event.metadata, max_kb);

            let params = InsertEventParams {
                event_id: event.event_id.as_deref(),
                session_id: &event.session_id,
                agent_type: &event.agent_type,
                event_type: &event.event_type,
                tool_name: event.tool_name.as_deref(),
                status: &event.status,
                tokens_in: event.tokens_in,
                tokens_out: event.tokens_out,
                branch: event.branch.as_deref(),
                project: event.project.as_deref(),
                duration_ms: event.duration_ms,
                client_timestamp: event.client_timestamp.as_deref(),
                metadata: &truncated.value,
                payload_truncated: truncated.truncated,
                model: event.model.as_deref(),
                cost_usd: event.cost_usd,
                cache_read_tokens: event.cache_read_tokens,
                cache_write_tokens: event.cache_write_tokens,
                source: event.source.as_deref().unwrap_or("api"),
            };

            let db = state.db.lock().await;
            match queries::insert_event(&db, &params) {
                Ok(Some(row)) => {
                    // TODO: broadcast "event" + "session_update" to SSE hub (Task 6)
                    (StatusCode::CREATED, Json(Value::from(serde_json::to_value(
                        IngestResponse { received: 1, ids: vec![row.id], duplicates: 0 },
                    ).unwrap()))).into_response()
                }
                Ok(None) => {
                    // Deduplicated
                    (StatusCode::OK, Json(Value::from(serde_json::to_value(
                        IngestResponse { received: 0, ids: vec![], duplicates: 1 },
                    ).unwrap()))).into_response()
                }
                Err(e) => {
                    warn!("insert_event error: {e}");
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(Value::from(
                        serde_json::json!({"error": "internal server error"}),
                    ))).into_response()
                }
            }
        }
    }
}

/// POST /api/events/batch — batch event ingest.
pub async fn ingest_batch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let events_array = match body.get("events").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => {
            return (StatusCode::BAD_REQUEST, Json(Value::from(serde_json::to_value(
                BatchFormatError { error: "Expected { events: [...] }" },
            ).unwrap()))).into_response();
        }
    };

    let max_kb = state.config.max_payload_kb;
    let mut ids: Vec<i64> = Vec::new();
    let mut duplicates: usize = 0;
    let mut rejected: Vec<BatchRejection> = Vec::new();

    let db = state.db.lock().await;

    for (i, item) in events_array.into_iter().enumerate() {
        let result = normalize_from_value(item);

        match result {
            NormalizeResult::Err { errors } => {
                rejected.push(BatchRejection {
                    index: i,
                    errors: errors
                        .iter()
                        .map(|e| format!("{}: {}", e.field, e.message))
                        .collect(),
                });
            }
            NormalizeResult::Ok { event } => {
                let truncated = truncate_metadata(&event.metadata, max_kb);

                let params = InsertEventParams {
                    event_id: event.event_id.as_deref(),
                    session_id: &event.session_id,
                    agent_type: &event.agent_type,
                    event_type: &event.event_type,
                    tool_name: event.tool_name.as_deref(),
                    status: &event.status,
                    tokens_in: event.tokens_in,
                    tokens_out: event.tokens_out,
                    branch: event.branch.as_deref(),
                    project: event.project.as_deref(),
                    duration_ms: event.duration_ms,
                    client_timestamp: event.client_timestamp.as_deref(),
                    metadata: &truncated.value,
                    payload_truncated: truncated.truncated,
                    model: event.model.as_deref(),
                    cost_usd: event.cost_usd,
                    cache_read_tokens: event.cache_read_tokens,
                    cache_write_tokens: event.cache_write_tokens,
                    source: event.source.as_deref().unwrap_or("api"),
                };

                match queries::insert_event(&db, &params) {
                    Ok(Some(row)) => {
                        // TODO: broadcast "event" to SSE hub (Task 6)
                        ids.push(row.id);
                    }
                    Ok(None) => {
                        duplicates += 1;
                    }
                    Err(e) => {
                        warn!("batch insert_event error at index {i}: {e}");
                        rejected.push(BatchRejection {
                            index: i,
                            errors: vec!["internal server error".into()],
                        });
                    }
                }
            }
        }
    }

    (StatusCode::CREATED, Json(Value::from(serde_json::to_value(
        BatchResponse { received: ids.len(), ids, duplicates, rejected },
    ).unwrap()))).into_response()
}
