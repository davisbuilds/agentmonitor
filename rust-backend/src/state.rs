use std::sync::Arc;
use std::time::Instant;

use rusqlite::Connection;
use tokio::sync::Mutex;

use crate::config::Config;

/// Shared application state accessible from all route handlers.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub config: Config,
    pub start_time: Instant,
}

impl AppState {
    pub fn new(db: Connection, config: Config) -> Arc<Self> {
        Arc::new(Self {
            db: Mutex::new(db),
            config,
            start_time: Instant::now(),
        })
    }
}
