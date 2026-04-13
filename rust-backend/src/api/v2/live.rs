use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde::Serialize;

use crate::db::v2_queries::{
    LiveItemsListParams, LiveSessionsListParams, get_live_session, get_session_items,
    get_session_turns, list_live_sessions,
};
use crate::state::AppState;

#[derive(Serialize)]
pub struct LiveSettingsResponse {
    enabled: bool,
    codex_mode: &'static str,
    capture: LiveCaptureResponse,
    diff_payload_max_bytes: usize,
}

#[derive(Serialize)]
pub struct LiveCaptureResponse {
    prompts: bool,
    reasoning: bool,
    tool_arguments: bool,
}

#[derive(Debug, Deserialize)]
pub struct LiveSessionsQuery {
    limit: Option<String>,
    cursor: Option<String>,
    project: Option<String>,
    agent: Option<String>,
    live_status: Option<String>,
    fidelity: Option<String>,
    active_only: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LiveItemsQuery {
    cursor: Option<String>,
    limit: Option<String>,
    kinds: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LiveStreamQuery {
    since: Option<String>,
    session_id: Option<String>,
}

#[derive(Serialize)]
struct SseError {
    error: &'static str,
    max_clients: usize,
}

fn parse_i64(input: Option<&str>) -> Option<i64> {
    input.and_then(|raw| raw.parse::<i64>().ok())
}

fn split_kinds(input: Option<&str>) -> Vec<String> {
    input
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub async fn live_settings_handler(
    State(state): State<Arc<AppState>>,
) -> Json<LiveSettingsResponse> {
    Json(LiveSettingsResponse {
        enabled: state.config.live.enabled,
        codex_mode: state.config.live.codex_mode.as_str(),
        capture: LiveCaptureResponse {
            prompts: state.config.live.capture.prompts,
            reasoning: state.config.live.capture.reasoning,
            tool_arguments: state.config.live.capture.tool_arguments,
        },
        diff_payload_max_bytes: state.config.live.diff_payload_max_bytes,
    })
}

pub async fn live_sessions_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LiveSessionsQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match list_live_sessions(
        &db,
        &LiveSessionsListParams {
            limit: parse_i64(query.limit.as_deref()),
            cursor: query.cursor,
            project: query.project,
            agent: query.agent,
            live_status: query.live_status,
            fidelity: query.fidelity,
            active_only: query.active_only.as_deref() == Some("true"),
        },
    ) {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to list live sessions" })),
        )
            .into_response(),
    }
}

pub async fn live_session_detail_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_live_session(&db, &session_id) {
        Ok(Some(session)) => (StatusCode::OK, Json(session)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get live session" })),
        )
            .into_response(),
    }
}

pub async fn live_session_turns_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_live_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match get_session_turns(&db, &session_id) {
            Ok(data) => (StatusCode::OK, Json(serde_json::json!({ "data": data }))).into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get live turns" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get live session" })),
        )
            .into_response(),
    }
}

pub async fn live_session_items_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<LiveItemsQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_live_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match get_session_items(
            &db,
            &session_id,
            &LiveItemsListParams {
                cursor: query.cursor,
                limit: parse_i64(query.limit.as_deref()),
                kinds: split_kinds(query.kinds.as_deref()),
            },
        ) {
            Ok(result) => (StatusCode::OK, Json(result)).into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get live items" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get live session" })),
        )
            .into_response(),
    }
}

pub async fn live_stream_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<LiveStreamQuery>,
) -> impl IntoResponse {
    let since_id = query
        .since
        .as_deref()
        .or_else(|| headers.get("last-event-id").and_then(|value| value.to_str().ok()))
        .and_then(|raw| raw.parse::<u64>().ok());

    let client = state
        .live_sse_hub
        .subscribe(crate::sse::live::LiveSubscribeOptions {
            session_id: query.session_id,
            since_id,
        })
        .await;

    match client {
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(SseError {
                error: "SSE client limit reached",
                max_clients: state.config.max_sse_clients,
            }),
        )
            .into_response(),
        Some(client) => {
            let stream = live_sse_stream(client);
            Sse::new(stream)
                .keep_alive(
                    KeepAlive::new()
                        .interval(std::time::Duration::from_millis(state.config.sse_heartbeat_ms))
                        .text("heartbeat"),
                )
                .into_response()
        }
    }
}

fn live_sse_stream(
    client: crate::sse::live::LiveSseClient,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    let (rx, replay, connected, session_id, guard) = client.into_parts();

    async_stream::stream! {
        let _guard = guard;
        let mut rx = rx;

        for event in replay {
            yield Ok(format_sse_event(&event));
        }
        yield Ok(format_sse_event(&connected));

        loop {
            match rx.recv().await {
                Ok(event) => {
                    if !matches_session_filter(&event.payload, session_id.as_deref()) {
                        continue;
                    }
                    yield Ok(format_sse_event(&event));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    }
}

fn format_sse_event(event: &crate::sse::live::LiveSseEvent) -> Event {
    let data = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    Event::default().id(event.id.to_string()).data(data)
}

fn matches_session_filter(payload: &serde_json::Value, session_id: Option<&str>) -> bool {
    match session_id {
        None => true,
        Some(session_id) => payload
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|candidate| candidate == session_id),
    }
}
