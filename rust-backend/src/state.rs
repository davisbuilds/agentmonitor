use std::sync::Arc;
use std::time::Instant;

use rusqlite::Connection;
use tokio::sync::Mutex;

use crate::config::Config;
use crate::sse::hub::SseHub;

/// Shared application state accessible from all route handlers.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub config: Config,
    pub start_time: Instant,
    pub sse_hub: SseHub,
}

impl AppState {
    pub fn new(db: Connection, config: Config) -> Arc<Self> {
        let sse_hub = SseHub::new(config.max_sse_clients);
        Arc::new(Self {
            db: Mutex::new(db),
            config,
            start_time: Instant::now(),
            sse_hub,
        })
    }
}
