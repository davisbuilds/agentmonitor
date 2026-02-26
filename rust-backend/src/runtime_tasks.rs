use std::sync::Arc;

use serde_json::json;

use crate::db::queries;
use crate::state::AppState;

/// Run one stats broadcast cycle.
/// Returns true when a stats event was broadcast to at least one connected SSE client.
pub async fn run_stats_broadcast_once(state: Arc<AppState>) -> bool {
    if state.sse_hub.client_count() == 0 {
        return false;
    }

    let db = state.db.lock().await;
    let stats = queries::get_stats(&db).unwrap_or_else(|_| queries::Stats {
        total_events: 0,
        active_sessions: 0,
        total_sessions: 0,
        total_tokens_in: 0,
        total_tokens_out: 0,
        total_cost_usd: 0.0,
    });
    let usage_monitor =
        queries::get_usage_monitor(&db, &state.config.usage_monitor).unwrap_or_default();
    drop(db);

    state.sse_hub.broadcast(
        "stats",
        &json!({
            "total_events": stats.total_events,
            "active_sessions": stats.active_sessions,
            "total_sessions": stats.total_sessions,
            "total_tokens_in": stats.total_tokens_in,
            "total_tokens_out": stats.total_tokens_out,
            "total_cost_usd": stats.total_cost_usd,
            "usage_monitor": usage_monitor,
        }),
    );
    true
}

/// Run one idle-session check cycle.
/// Returns the number of sessions transitioned from active -> idle.
pub async fn run_idle_check_once(state: Arc<AppState>) -> usize {
    let timeout_minutes = state.config.session_timeout_minutes;
    let db = state.db.lock().await;
    let idled = queries::update_idle_sessions(&db, timeout_minutes).unwrap_or(0);
    drop(db);

    if idled > 0 && state.sse_hub.client_count() > 0 {
        state.sse_hub.broadcast(
            "session_update",
            &json!({ "type": "idle_check", "idled": idled }),
        );
    }

    idled
}
