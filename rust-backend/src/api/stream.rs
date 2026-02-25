use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct SseError {
    error: &'static str,
    max_clients: usize,
}

/// GET /api/stream — SSE endpoint.
pub async fn stream_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let client = state.sse_hub.subscribe();

    match client {
        None => {
            let max = state.config.max_sse_clients;
            (StatusCode::SERVICE_UNAVAILABLE, Json(SseError {
                error: "SSE client limit reached",
                max_clients: max,
            })).into_response()
        }
        Some(client) => {
            let stream = sse_stream(client);
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

fn sse_stream(
    client: crate::sse::hub::SseClient,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    let connected = serde_json::json!({
        "type": "connected",
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });
    let connected_data = serde_json::to_string(&connected).unwrap();

    let (rx, guard) = client.into_parts();

    async_stream::stream! {
        // Move guard into the stream so it stays alive for the stream's lifetime.
        let _guard = guard;
        let mut rx = rx;

        // Send connected message
        yield Ok(Event::default().data(connected_data));

        // Relay broadcast messages
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    // The hub formats as "data: ...\n\n", but axum's Sse
                    // wraps Event::data() itself. Strip the hub's framing.
                    let content = msg
                        .strip_prefix("data: ")
                        .and_then(|s| s.strip_suffix("\n\n"))
                        .unwrap_or(&msg);
                    yield Ok(Event::default().data(content));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
        // _guard drops here, decrementing the client count.
    }
}
