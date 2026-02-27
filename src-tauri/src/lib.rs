pub mod backend;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = match tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let backend = match tauri::async_runtime::block_on(backend::start_embedded_backend()) {
        Ok(backend) => backend,
        Err(err) => {
          eprintln!("Failed to start embedded backend: {err}");
          std::process::exit(1);
        }
      };
      let backend_url = format!("http://{}", backend.local_addr());
      let parsed_url = match tauri::Url::parse(&backend_url) {
        Ok(url) => url,
        Err(err) => {
          eprintln!("Failed to parse embedded backend URL ({backend_url}): {err}");
          std::process::exit(1);
        }
      };

      let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => {
          eprintln!("Failed to locate Tauri main window during setup");
          std::process::exit(1);
        }
      };

      if let Err(err) = window.navigate(parsed_url) {
        eprintln!("Failed to navigate Tauri window to embedded backend: {err}");
        std::process::exit(1);
      }

      log::info!("embedded backend listening on {backend_url}");
      app.manage(backend::EmbeddedBackendState::new(backend));
      Ok(())
    })
    .build(tauri::generate_context!()) {
      Ok(app) => app,
      Err(err) => {
        eprintln!("Failed to start Tauri app: {err}");
        return;
      }
    };

  app.run(|app_handle, event| {
    if matches!(event, tauri::RunEvent::Exit) {
      if let Some(backend_state) = app_handle.try_state::<backend::EmbeddedBackendState>() {
        if let Err(err) = backend_state.shutdown_blocking() {
          log::error!("embedded backend shutdown failed: {err}");
        }
      }
    }
  });
}
