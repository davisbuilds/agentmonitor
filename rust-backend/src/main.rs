use tracing::info;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::runtime_contract::start_with_config;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "agentmonitor_rs=info".parse().unwrap()),
        )
        .init();

    let config = Config::from_env();
    let runtime = start_with_config(config)
        .await
        .expect("Failed to start runtime host");
    info!("agentmonitor-rs listening on {}", runtime.base_url());

    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C signal handler");
    info!("Shutdown signal received, stopping runtime host");

    runtime
        .shutdown()
        .await
        .expect("Runtime host shutdown failed");
}
