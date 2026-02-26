pub mod api;
pub mod config;
pub mod contracts;
pub mod db;
pub mod importer;
pub mod otel;
pub mod pricing;
pub mod sse;
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
        .route("/api/stats", get(api::stats_handler))
        .route("/api/stats/tools", get(api::stats_tools_handler))
        .route("/api/stats/cost", get(api::stats_cost_handler))
        .route("/api/stats/usage-monitor", get(api::usage_monitor_handler))
        .route("/api/otel/v1/logs", post(api::otel_logs_handler))
        .route("/api/otel/v1/metrics", post(api::otel_metrics_handler))
        .route("/api/otel/v1/traces", post(api::otel_traces_handler))
        .route("/api/sessions", get(api::sessions_list_handler))
        .route(
            "/api/sessions/{id}/transcript",
            get(api::session_transcript_handler),
        )
        .route("/api/sessions/{id}", get(api::session_detail_handler))
        .route("/api/filter-options", get(api::filter_options_handler))
        .route("/api/stream", get(api::stream_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}
