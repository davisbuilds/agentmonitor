use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::info;

use crate::auto_import::run_auto_import_once;
use crate::config::Config;
use crate::db;
use crate::runtime_tasks::{run_idle_check_once, run_stats_broadcast_once};
use crate::state::AppState;

#[derive(Debug)]
pub enum RuntimeHostError {
    Db(rusqlite::Error),
    Bind(std::io::Error),
    Server(std::io::Error),
    Join(tokio::task::JoinError),
}

impl fmt::Display for RuntimeHostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(err) => write!(f, "database initialization failed: {err}"),
            Self::Bind(err) => write!(f, "listener bind failed: {err}"),
            Self::Server(err) => write!(f, "server exited with error: {err}"),
            Self::Join(err) => write!(f, "task join failed: {err}"),
        }
    }
}

impl std::error::Error for RuntimeHostError {}

pub struct RuntimeHost {
    local_addr: SocketAddr,
    shutdown_tx: Option<watch::Sender<bool>>,
    server_handle: JoinHandle<std::io::Result<()>>,
    task_handles: Vec<JoinHandle<()>>,
}

impl RuntimeHost {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn stop(mut self) -> Result<(), RuntimeHostError> {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(true);
        }

        for handle in self.task_handles {
            if let Err(err) = handle.await {
                if !err.is_cancelled() {
                    return Err(RuntimeHostError::Join(err));
                }
            }
        }

        match self.server_handle.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => Err(RuntimeHostError::Server(err)),
            Err(err) => Err(RuntimeHostError::Join(err)),
        }
    }
}

pub async fn start_with_config(config: Config) -> Result<RuntimeHost, RuntimeHostError> {
    let bind_addr = config.bind_addr();
    let auto_import_interval_minutes = config.auto_import_interval_minutes;
    let stats_interval_ms = config.stats_interval_ms;

    let conn = db::initialize(&config.db_path).map_err(RuntimeHostError::Db)?;
    let state: Arc<AppState> = AppState::new(conn, config);
    let app = crate::build_router(Arc::clone(&state));

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(RuntimeHostError::Bind)?;
    let local_addr = listener.local_addr().map_err(RuntimeHostError::Bind)?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let mut task_handles = Vec::new();
    task_handles.push(spawn_stats_task(
        Arc::clone(&state),
        stats_interval_ms,
        shutdown_rx.clone(),
    ));
    task_handles.push(spawn_idle_task(Arc::clone(&state), shutdown_rx.clone()));
    if auto_import_interval_minutes > 0 {
        info!("Auto-import: every {}m", auto_import_interval_minutes);
        task_handles.push(spawn_auto_import_task(
            Arc::clone(&state),
            auto_import_interval_minutes,
            shutdown_rx.clone(),
        ));
    }

    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(wait_for_shutdown_signal(shutdown_rx))
            .await
    });

    Ok(RuntimeHost {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
        server_handle,
        task_handles,
    })
}

fn spawn_stats_task(
    state: Arc<AppState>,
    interval_ms: u64,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if sleep_or_shutdown(Duration::from_millis(interval_ms), &mut shutdown_rx).await {
                break;
            }
            let _ = run_stats_broadcast_once(Arc::clone(&state)).await;
        }
    })
}

fn spawn_idle_task(state: Arc<AppState>, mut shutdown_rx: watch::Receiver<bool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if sleep_or_shutdown(Duration::from_secs(60), &mut shutdown_rx).await {
                break;
            }
            let _ = run_idle_check_once(Arc::clone(&state)).await;
        }
    })
}

fn spawn_auto_import_task(
    state: Arc<AppState>,
    interval_minutes: u64,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let interval = Duration::from_secs(interval_minutes * 60);
        if sleep_or_shutdown(Duration::from_secs(5), &mut shutdown_rx).await {
            return;
        }
        let _ = run_auto_import_once(Arc::clone(&state)).await;

        loop {
            if sleep_or_shutdown(interval, &mut shutdown_rx).await {
                break;
            }
            let _ = run_auto_import_once(Arc::clone(&state)).await;
        }
    })
}

async fn sleep_or_shutdown(duration: Duration, shutdown_rx: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        changed = shutdown_rx.changed() => match changed {
            Ok(_) => *shutdown_rx.borrow(),
            Err(_) => true,
        }
    }
}

async fn wait_for_shutdown_signal(mut shutdown_rx: watch::Receiver<bool>) {
    while shutdown_rx.changed().await.is_ok() {
        if *shutdown_rx.borrow() {
            break;
        }
    }
}
