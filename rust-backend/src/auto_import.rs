use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tracing::{error, info};

use crate::db::v2_queries::get_live_session;
use crate::importer::{ImportOptions, ImportResult, ImportSource, run_import};
use crate::state::AppState;

/// Run one auto-import cycle and emit a session_update broadcast when new events are imported.
pub async fn run_auto_import_once(state: Arc<AppState>) -> ImportResult {
    run_auto_import_once_with_dirs(state, None, None).await
}

/// Test hook for running an auto-import cycle against explicit source directories.
pub async fn run_auto_import_once_with_dirs(
    state: Arc<AppState>,
    claude_dir: Option<PathBuf>,
    codex_dir: Option<PathBuf>,
) -> ImportResult {
    let max_payload_kb = state.config.max_payload_kb;
    let options = ImportOptions {
        source: ImportSource::All,
        from: None,
        to: None,
        dry_run: false,
        force: false,
        claude_dir,
        codex_dir,
        max_payload_kb,
    };

    let task_state = Arc::clone(&state);
    let result = tokio::task::spawn_blocking(move || {
        let db = task_state.db.blocking_lock();
        run_import(&db, &options)
    })
    .await;

    let result = match result {
        Ok(result) => result,
        Err(err) => {
            error!("auto-import task failed: {err}");
            return ImportResult {
                files: vec![],
                total_files: 0,
                total_events_found: 0,
                total_events_imported: 0,
                total_duplicates: 0,
                skipped_files: 0,
            };
        }
    };

    if result.total_events_imported > 0 {
        let imported_files = result.total_files.saturating_sub(result.skipped_files);
        info!(
            "Auto-import: imported {} events from {} file(s)",
            result.total_events_imported, imported_files
        );

        if state.sse_hub.client_count() > 0 {
            state.sse_hub.broadcast(
                "session_update",
                &json!({
                    "type": "auto_import",
                    "imported": result.total_events_imported
                }),
            );
        }
    }

    broadcast_live_import_updates(Arc::clone(&state), &result).await;

    result
}

async fn broadcast_live_import_updates(state: Arc<AppState>, result: &ImportResult) {
    let session_ids = result
        .files
        .iter()
        .filter(|file| !file.skipped_unchanged)
        .filter_map(|file| {
            let path = PathBuf::from(&file.path);
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(ToString::to_string)
        })
        .collect::<std::collections::BTreeSet<_>>();

    if session_ids.is_empty() {
        return;
    }

    let db = state.db.lock().await;
    let mut payloads = Vec::new();
    for session_id in session_ids {
        let Ok(Some(session)) = get_live_session(&db, &session_id) else {
            continue;
        };
        payloads.push((
            json!({
                "session_id": session.id,
                "live_status": session.live_status,
                "integration_mode": session.integration_mode,
                "fidelity": session.fidelity,
                "last_item_at": session.last_item_at,
            }),
            json!({
                "session_id": session.id,
                "inserted_turns": 0,
                "reset": false,
            }),
            json!({
                "session_id": session.id,
                "inserted_items": 0,
                "last_item_at": session.last_item_at,
            }),
        ));
    }
    drop(db);

    for (session_presence, turn_update, item_delta) in payloads {
        state
            .live_sse_hub
            .broadcast("session_presence", session_presence)
            .await;
        state
            .live_sse_hub
            .broadcast("turn_update", turn_update)
            .await;
        state
            .live_sse_hub
            .broadcast("item_delta", item_delta)
            .await;
    }
}
