use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::db::queries;
use crate::state::AppState;

/// GET /api/filter-options — distinct values used by dashboard filters.
pub async fn filter_options_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let db = state.db.lock().await;
    match queries::get_filter_options(&db) {
        Ok(options) => (StatusCode::OK, Json(options)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}
