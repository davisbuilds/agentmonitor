use std::sync::Arc;

use tracing::info;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::state::AppState;

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

    let app = agentmonitor_rs::build_router(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("Failed to bind");

    info!("agentmonitor-rs listening on {bind_addr}");
    axum::serve(listener, app).await.expect("Server error");
}
