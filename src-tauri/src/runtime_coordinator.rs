use std::fmt;

use tauri::Manager;

use crate::backend;

#[derive(Debug)]
pub enum RuntimeCoordinatorError {
    BackendStart(String),
    UrlParse(String),
    MainWindowMissing,
    Navigate(String),
}

impl fmt::Display for RuntimeCoordinatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BackendStart(msg) => write!(f, "{msg}"),
            Self::UrlParse(msg) => write!(f, "{msg}"),
            Self::MainWindowMissing => write!(f, "Failed to locate Tauri main window during setup"),
            Self::Navigate(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for RuntimeCoordinatorError {}

pub fn initialize(app: &tauri::App) -> Result<(), RuntimeCoordinatorError> {
    let app_data_dir = app.path().app_data_dir().ok();
    let backend = tauri::async_runtime::block_on(backend::start_embedded_backend_with_app_data_dir(
        app_data_dir,
    ))
        .map_err(|err| RuntimeCoordinatorError::BackendStart(err.to_string()))?;
    let backend_url = backend.base_url().to_string();

    let parsed_url = tauri::Url::parse(&backend_url).map_err(|err| {
        RuntimeCoordinatorError::UrlParse(format!(
            "Failed to parse embedded backend URL ({backend_url}): {err}"
        ))
    })?;

    let window = app
        .get_webview_window("main")
        .ok_or(RuntimeCoordinatorError::MainWindowMissing)?;
    window.navigate(parsed_url).map_err(|err| {
        RuntimeCoordinatorError::Navigate(format!(
            "Failed to navigate Tauri window to embedded backend: {err}"
        ))
    })?;

    log::info!("embedded backend listening on {backend_url}");
    app.manage(backend::EmbeddedBackendState::new(backend));
    Ok(())
}

pub fn shutdown(app_handle: &tauri::AppHandle) {
    if let Some(backend_state) = app_handle.try_state::<backend::EmbeddedBackendState>() {
        if let Err(err) = backend_state.shutdown_blocking() {
            log::error!("embedded backend shutdown failed: {err}");
        }
    }
}
