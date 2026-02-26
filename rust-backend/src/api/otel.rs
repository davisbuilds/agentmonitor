use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde_json::{Value, json};
use tracing::warn;

use crate::db::queries::{self, InsertEventParams};
use crate::otel::parser::{parse_otel_logs, parse_otel_metrics};
use crate::state::AppState;
use crate::util::truncate::truncate_metadata;

fn reject_protobuf_if_needed(headers: &HeaderMap) -> Option<axum::response::Response> {
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    if content_type.contains("application/x-protobuf")
        || content_type.contains("application/protobuf")
    {
        return Some(
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({
                    "error": "Protobuf not supported yet. Use JSON format.",
                    "hint": "Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
                })),
            )
                .into_response(),
        );
    }

    None
}

fn parse_json_body(body: Bytes) -> Result<Value, axum::response::Response> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice::<Value>(&body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid JSON payload"})),
        )
            .into_response()
    })
}

/// POST /api/otel/v1/logs
pub async fn otel_logs_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = reject_protobuf_if_needed(&headers) {
        return resp;
    }

    let payload = match parse_json_body(body) {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let parsed = parse_otel_logs(&payload);
    let max_kb = state.config.max_payload_kb;
    let db = state.db.lock().await;

    for event in parsed {
        let truncated = truncate_metadata(&event.metadata, max_kb);
        let params = InsertEventParams {
            event_id: None,
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
            source: "otel",
        };

        match queries::insert_event(&db, &params) {
            Ok(Some(row)) => {
                let row_value = serde_json::to_value(&row).unwrap_or_else(|_| json!({}));
                state.sse_hub.broadcast("event", &row_value);
            }
            Ok(None) => {}
            Err(e) => warn!("otel logs insert_event error: {e}"),
        }
    }

    (StatusCode::OK, Json(json!({}))).into_response()
}

/// POST /api/otel/v1/metrics
pub async fn otel_metrics_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = reject_protobuf_if_needed(&headers) {
        return resp;
    }

    let payload = match parse_json_body(body) {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let mut cumulative = state.otel_cumulative_state.lock().await;
    let deltas = parse_otel_metrics(&payload, &mut cumulative);
    drop(cumulative);

    let max_kb = state.config.max_payload_kb;
    let db = state.db.lock().await;

    for delta in deltas {
        let has_tokens = delta.tokens_in_delta > 0
            || delta.tokens_out_delta > 0
            || delta.cache_read_delta > 0
            || delta.cache_write_delta > 0;
        let has_cost = delta.cost_usd_delta > 0.0;
        if !has_tokens && !has_cost {
            continue;
        }

        let metadata = json!({
            "_synthetic": true,
            "_source": "otel_metric",
        });
        let truncated = truncate_metadata(&metadata, max_kb);

        let params = InsertEventParams {
            event_id: None,
            session_id: &delta.session_id,
            agent_type: &delta.agent_type,
            event_type: "llm_response",
            tool_name: None,
            status: "success",
            tokens_in: delta.tokens_in_delta,
            tokens_out: delta.tokens_out_delta,
            branch: None,
            project: None,
            duration_ms: None,
            client_timestamp: None,
            metadata: &truncated.value,
            payload_truncated: truncated.truncated,
            model: delta.model.as_deref(),
            cost_usd: if has_cost {
                Some(delta.cost_usd_delta)
            } else {
                None
            },
            cache_read_tokens: delta.cache_read_delta,
            cache_write_tokens: delta.cache_write_delta,
            source: "otel",
        };

        match queries::insert_event(&db, &params) {
            Ok(Some(row)) => {
                let row_value = serde_json::to_value(&row).unwrap_or_else(|_| json!({}));
                state.sse_hub.broadcast("event", &row_value);
            }
            Ok(None) => {}
            Err(e) => warn!("otel metrics insert_event error: {e}"),
        }
    }

    (StatusCode::OK, Json(json!({}))).into_response()
}

/// POST /api/otel/v1/traces — accepted stub.
pub async fn otel_traces_handler(headers: HeaderMap, _body: Bytes) -> impl IntoResponse {
    if let Some(resp) = reject_protobuf_if_needed(&headers) {
        return resp;
    }
    (StatusCode::OK, Json(json!({}))).into_response()
}
