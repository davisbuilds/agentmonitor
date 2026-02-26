use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

use crate::db::queries::{self, SessionFilters};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SessionsQuery {
    status: Option<String>,
    exclude_status: Option<String>,
    agent_type: Option<String>,
    since: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SessionDetailQuery {
    event_limit: Option<String>,
    limit: Option<String>,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<queries::SessionRow>,
    total: usize,
}

#[derive(Serialize)]
struct SessionNotFound {
    error: &'static str,
}

fn parse_i64(input: Option<&str>) -> Option<i64> {
    input.and_then(|raw| raw.parse::<i64>().ok())
}

/// GET /api/sessions — list sessions with optional filters.
pub async fn sessions_list_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionsQuery>,
) -> impl IntoResponse {
    let filters = SessionFilters {
        status: query.status,
        exclude_status: query.exclude_status,
        agent_type: query.agent_type,
        since: query.since,
        limit: parse_i64(query.limit.as_deref()),
    };

    let db = state.db.lock().await;
    match queries::get_sessions(&db, &filters) {
        Ok(sessions) => {
            let total = sessions.len();
            (StatusCode::OK, Json(SessionsResponse { sessions, total })).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}

/// GET /api/sessions/:id — session detail plus most recent events.
pub async fn session_detail_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<SessionDetailQuery>,
) -> impl IntoResponse {
    let event_limit = parse_i64(query.event_limit.as_deref())
        .or_else(|| parse_i64(query.limit.as_deref()))
        .unwrap_or(10);

    let db = state.db.lock().await;
    match queries::get_session_with_events(&db, &session_id, event_limit) {
        Ok((Some(session), events)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "session": session,
                "events": events,
            })),
        )
            .into_response(),
        Ok((None, _)) => (
            StatusCode::NOT_FOUND,
            Json(SessionNotFound {
                error: "Session not found",
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}
