use std::sync::Arc;
use std::time::Duration;

use tracing::info;

use agentmonitor_rs::auto_import::run_auto_import_once;
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
    let auto_import_interval_minutes = config.auto_import_interval_minutes;

    let conn = db::initialize(&config.db_path).expect("Failed to initialize database");
    let state: Arc<AppState> = AppState::new(conn, config);

    let app = agentmonitor_rs::build_router(Arc::clone(&state));

    if auto_import_interval_minutes > 0 {
        let task_state = Arc::clone(&state);
        let interval = Duration::from_secs(auto_import_interval_minutes * 60);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = run_auto_import_once(Arc::clone(&task_state)).await;

            loop {
                tokio::time::sleep(interval).await;
                let _ = run_auto_import_once(Arc::clone(&task_state)).await;
            }
        });
        info!("Auto-import: every {}m", auto_import_interval_minutes);
    }

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("Failed to bind");

    info!("agentmonitor-rs listening on {bind_addr}");
    axum::serve(listener, app).await.expect("Server error");
}
