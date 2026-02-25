mod api;
mod config;
mod contracts;
mod db;
mod state;
mod util;

use std::sync::Arc;

use axum::Router;
use axum::routing::get;
use tower_http::cors::CorsLayer;
use tracing::info;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "agentmonitor_rs=info".parse().unwrap()),
        )
        .init();

    let config = Config::from_env();
    let bind_addr = config.bind_addr();

    let conn = db::initialize(&config.db_path).expect("Failed to initialize database");
    let state: Arc<AppState> = AppState::new(conn, config);

    let app = Router::new()
        .route("/api/health", get(api::health_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("Failed to bind");

    info!("agentmonitor-rs listening on {bind_addr}");
    axum::serve(listener, app).await.expect("Server error");
}
