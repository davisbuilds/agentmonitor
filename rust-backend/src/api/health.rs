use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
    uptime: u64,
    db_size_bytes: u64,
    sse_clients: usize,
}

pub async fn health_handler(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let db_size = std::fs::metadata(&state.config.db_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Json(HealthResponse {
        status: "ok",
        uptime: state.start_time.elapsed().as_secs(),
        db_size_bytes: db_size,
        sse_clients: 0, // placeholder until SSE hub is wired
    })
}
