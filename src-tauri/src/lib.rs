pub mod backend;
pub mod ipc;
pub mod runtime_coordinator;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = match tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc::desktop_runtime_status])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Err(err) = runtime_coordinator::initialize(app) {
                eprintln!("{err}");
                std::process::exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            eprintln!("Failed to start Tauri app: {err}");
            return;
        }
    };

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            runtime_coordinator::shutdown(app_handle);
        }
    });
}
