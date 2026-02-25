pub mod api;
pub mod config;
pub mod contracts;
pub mod db;
pub mod state;
pub mod util;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use tower_http::cors::CorsLayer;

use crate::state::AppState;

/// Build the application router with all routes wired.
pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(api::health_handler))
        .route("/api/events", post(api::ingest_single))
        .route("/api/events/batch", post(api::ingest_batch))
        .layer(CorsLayer::permissive())
        .with_state(state)
}
