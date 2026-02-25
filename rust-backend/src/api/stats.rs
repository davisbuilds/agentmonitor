use std::sync::Arc;

use axum::Json;
use axum::extract::State;

use crate::db::queries;
use crate::state::AppState;

/// GET /api/stats — aggregated statistics.
pub async fn stats_handler(
    State(state): State<Arc<AppState>>,
) -> Json<queries::Stats> {
    let db = state.db.lock().await;
    let stats = queries::get_stats(&db).unwrap_or_else(|_| queries::Stats {
        total_events: 0,
        active_sessions: 0,
        total_sessions: 0,
        total_tokens_in: 0,
        total_tokens_out: 0,
        total_cost_usd: 0.0,
    });
    Json(stats)
}
