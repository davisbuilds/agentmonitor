use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::db::v2_queries::{
    AnalyticsParams, MessagesListParams, PinsListParams, SearchParams, SessionsListParams,
    get_analytics_activity, get_analytics_agents, get_analytics_coverage,
    get_analytics_hour_of_week, get_analytics_projects, get_analytics_summary, get_analytics_tools,
    get_analytics_top_sessions, get_analytics_velocity, get_browsing_session, get_distinct_agents,
    get_distinct_projects, get_session_activity, get_session_children, get_session_messages,
    get_usage_agents, get_usage_coverage, get_usage_daily, get_usage_models, get_usage_projects,
    get_usage_summary, get_usage_top_sessions, list_browsing_sessions, list_pinned_messages,
    pin_message, search_messages, unpin_message,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SessionsQuery {
    limit: Option<String>,
    cursor: Option<String>,
    project: Option<String>,
    agent: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    min_messages: Option<String>,
    max_messages: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    offset: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    project: Option<String>,
    agent: Option<String>,
    sort: Option<String>,
    limit: Option<String>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AnalyticsQuery {
    date_from: Option<String>,
    date_to: Option<String>,
    project: Option<String>,
    agent: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PinsQuery {
    project: Option<String>,
}

fn parse_i64(input: Option<&str>) -> Option<i64> {
    input.and_then(|raw| raw.parse::<i64>().ok())
}

fn as_sessions_params(query: &SessionsQuery) -> SessionsListParams {
    SessionsListParams {
        limit: parse_i64(query.limit.as_deref()),
        cursor: query.cursor.clone(),
        project: query.project.clone(),
        agent: query.agent.clone(),
        date_from: query.date_from.clone(),
        date_to: query.date_to.clone(),
        min_messages: parse_i64(query.min_messages.as_deref()),
        max_messages: parse_i64(query.max_messages.as_deref()),
    }
}

fn as_analytics_params(query: &AnalyticsQuery) -> AnalyticsParams {
    AnalyticsParams {
        date_from: query.date_from.clone(),
        date_to: query.date_to.clone(),
        project: query.project.clone(),
        agent: query.agent.clone(),
        limit: parse_i64(query.limit.as_deref()),
    }
}

pub async fn list_sessions_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionsQuery>,
) -> impl IntoResponse {
    let params = as_sessions_params(&query);
    let db = state.db.lock().await;
    match list_browsing_sessions(&db, &params) {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to list sessions" })),
        )
            .into_response(),
    }
}

pub async fn session_detail_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_browsing_session(&db, &session_id) {
        Ok(Some(session)) => (StatusCode::OK, Json(session)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get session" })),
        )
            .into_response(),
    }
}

pub async fn session_messages_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_browsing_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match get_session_messages(
            &db,
            &session_id,
            &MessagesListParams {
                offset: parse_i64(query.offset.as_deref()),
                limit: parse_i64(query.limit.as_deref()),
            },
        ) {
            Ok(result) => (StatusCode::OK, Json(result)).into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get messages" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get session" })),
        )
            .into_response(),
    }
}

pub async fn session_activity_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_browsing_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match get_session_activity(&db, &session_id) {
            Ok(result) => (StatusCode::OK, Json(result)).into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get session activity" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get session" })),
        )
            .into_response(),
    }
}

pub async fn session_pins_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_browsing_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match list_pinned_messages(
            &db,
            &PinsListParams {
                session_id: Some(session_id),
                ..Default::default()
            },
        ) {
            Ok(data) => (StatusCode::OK, Json(serde_json::json!({ "data": data }))).into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to list session pins" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get session" })),
        )
            .into_response(),
    }
}

pub async fn list_pins_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PinsQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match list_pinned_messages(
        &db,
        &PinsListParams {
            project: query.project,
            session_id: None,
        },
    ) {
        Ok(data) => (StatusCode::OK, Json(serde_json::json!({ "data": data }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to list pins" })),
        )
            .into_response(),
    }
}

pub async fn pin_message_handler(
    State(state): State<Arc<AppState>>,
    Path((session_id, message_id)): Path<(String, i64)>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_browsing_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match pin_message(&db, &session_id, message_id) {
            Ok(Some(pin)) => (StatusCode::CREATED, Json(pin)).into_response(),
            Ok(None) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Message not found" })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to pin message" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get session" })),
        )
            .into_response(),
    }
}

pub async fn unpin_message_handler(
    State(state): State<Arc<AppState>>,
    Path((session_id, message_id)): Path<(String, i64)>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_browsing_session(&db, &session_id) {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Session not found" })),
        )
            .into_response(),
        Ok(Some(_)) => match unpin_message(&db, &session_id, message_id) {
            Ok((removed, message_ordinal)) if removed => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "removed": true,
                    "message_ordinal": message_ordinal,
                })),
            )
                .into_response(),
            Ok(_) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Pin not found" })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to unpin message" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get session" })),
        )
            .into_response(),
    }
}

pub async fn session_children_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_session_children(&db, &session_id) {
        Ok(children) => (
            StatusCode::OK,
            Json(serde_json::json!({ "data": children })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get children" })),
        )
            .into_response(),
    }
}

pub async fn search_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    let Some(raw_q) = query.q.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Query parameter \"q\" is required" })),
        )
            .into_response();
    };
    let q = raw_q.trim();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Query parameter \"q\" is required" })),
        )
            .into_response();
    }

    let db = state.db.lock().await;
    match search_messages(
        &db,
        &SearchParams {
            q: q.to_string(),
            project: query.project.clone(),
            agent: query.agent.clone(),
            sort: query.sort.clone(),
            limit: parse_i64(query.limit.as_deref()),
            cursor: query.cursor.clone(),
        },
    ) {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(err) if is_invalid_search_query(&err) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid search query syntax" })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Search failed" })),
        )
            .into_response(),
    }
}

pub async fn analytics_summary_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_analytics_summary(&db, &as_analytics_params(&query)) {
        Ok(summary) => (StatusCode::OK, Json(summary)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get analytics summary" })),
        )
            .into_response(),
    }
}

pub async fn analytics_activity_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_analytics_activity(&db, &params) {
        Ok(data) => match get_analytics_coverage(&db, &params, "all_sessions") {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get activity data" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get activity data" })),
        )
            .into_response(),
    }
}

pub async fn analytics_projects_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_analytics_projects(&db, &params) {
        Ok(data) => match get_analytics_coverage(&db, &params, "all_sessions") {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get project data" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get project data" })),
        )
            .into_response(),
    }
}

pub async fn analytics_tools_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_analytics_tools(&db, &params) {
        Ok(data) => match get_analytics_coverage(&db, &params, "tool_analytics_capable") {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get tool data" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get tool data" })),
        )
            .into_response(),
    }
}

pub async fn analytics_hour_of_week_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_analytics_hour_of_week(&db, &params) {
        Ok(data) => match get_analytics_coverage(&db, &params, "all_sessions") {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get hour-of-week analytics" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get hour-of-week analytics" })),
        )
            .into_response(),
    }
}

pub async fn analytics_top_sessions_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_analytics_top_sessions(&db, &params) {
        Ok(data) => match get_analytics_coverage(&db, &params, "all_sessions") {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get top sessions analytics" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get top sessions analytics" })),
        )
            .into_response(),
    }
}

pub async fn analytics_velocity_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_analytics_velocity(&db, &as_analytics_params(&query)) {
        Ok(data) => (StatusCode::OK, Json(data)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get velocity analytics" })),
        )
            .into_response(),
    }
}

pub async fn analytics_agents_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_analytics_agents(&db, &params) {
        Ok(data) => match get_analytics_coverage(&db, &params, "all_sessions") {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get agent analytics" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get agent analytics" })),
        )
            .into_response(),
    }
}

pub async fn usage_summary_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_usage_summary(&db, &as_analytics_params(&query)) {
        Ok(data) => (StatusCode::OK, Json(data)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get usage summary" })),
        )
            .into_response(),
    }
}

pub async fn usage_daily_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_usage_daily(&db, &params) {
        Ok(data) => match get_usage_coverage(&db, &params) {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get daily usage" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get daily usage" })),
        )
            .into_response(),
    }
}

pub async fn usage_projects_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_usage_projects(&db, &params) {
        Ok(data) => match get_usage_coverage(&db, &params) {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get usage by project" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get usage by project" })),
        )
            .into_response(),
    }
}

pub async fn usage_models_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_usage_models(&db, &params) {
        Ok(data) => match get_usage_coverage(&db, &params) {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get usage by model" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get usage by model" })),
        )
            .into_response(),
    }
}

pub async fn usage_agents_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_usage_agents(&db, &params) {
        Ok(data) => match get_usage_coverage(&db, &params) {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get usage by agent" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get usage by agent" })),
        )
            .into_response(),
    }
}

pub async fn usage_top_sessions_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnalyticsQuery>,
) -> impl IntoResponse {
    let params = as_analytics_params(&query);
    let db = state.db.lock().await;
    match get_usage_top_sessions(&db, &params) {
        Ok(data) => match get_usage_coverage(&db, &params) {
            Ok(coverage) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "data": data,
                    "coverage": coverage,
                })),
            )
                .into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to get top usage sessions" })),
            )
                .into_response(),
        },
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get top usage sessions" })),
        )
            .into_response(),
    }
}

pub async fn projects_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_distinct_projects(&db) {
        Ok(data) => (StatusCode::OK, Json(serde_json::json!({ "data": data }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get projects" })),
        )
            .into_response(),
    }
}

pub async fn agents_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let db = state.db.lock().await;
    match get_distinct_agents(&db) {
        Ok(data) => (StatusCode::OK, Json(serde_json::json!({ "data": data }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get agents" })),
        )
            .into_response(),
    }
}

fn is_invalid_search_query(err: &rusqlite::Error) -> bool {
    let message = err.to_string().to_ascii_lowercase();
    message.contains("fts5")
        || message.contains("match")
        || message.contains("syntax error")
        || message.contains("malformed")
}
