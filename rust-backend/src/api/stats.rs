use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::db::queries;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct StatsQuery {
    agent_type: Option<String>,
    since: Option<String>,
    limit: Option<String>,
}

fn parse_i64(input: Option<&str>) -> Option<i64> {
    input.and_then(|raw| raw.parse::<i64>().ok())
}

fn to_filters(query: &StatsQuery) -> queries::AnalyticsFilters {
    queries::AnalyticsFilters {
        agent_type: query.agent_type.clone(),
        since: query.since.clone(),
    }
}

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

/// GET /api/stats/tools — tool analytics.
pub async fn stats_tools_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StatsQuery>,
) -> impl IntoResponse {
    let filters = to_filters(&query);
    let db = state.db.lock().await;
    match queries::get_tool_analytics(&db, &filters) {
        Ok(tools) => (StatusCode::OK, Json(serde_json::json!({ "tools": tools }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}

/// GET /api/stats/cost — cost timeline + breakdowns.
pub async fn stats_cost_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StatsQuery>,
) -> impl IntoResponse {
    let filters = to_filters(&query);
    let limit = parse_i64(query.limit.as_deref()).unwrap_or(10).max(1);

    let db = state.db.lock().await;
    let timeline = queries::get_cost_over_time(&db, &filters);
    let by_project = queries::get_cost_by_project(&db, limit, &filters);
    let by_model = queries::get_cost_by_model(&db, &filters);

    match (timeline, by_project, by_model) {
        (Ok(timeline), Ok(by_project), Ok(by_model)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "timeline": timeline,
                "by_project": by_project,
                "by_model": by_model,
            })),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}

/// GET /api/stats/usage-monitor — rolling usage by agent type.
pub async fn usage_monitor_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match queries::get_usage_monitor(&db, &state.config.usage_monitor) {
        Ok(data) => (StatusCode::OK, Json(data)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}
