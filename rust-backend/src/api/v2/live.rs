use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct LiveSettingsResponse {
    enabled: bool,
    codex_mode: &'static str,
    capture: LiveCaptureResponse,
    diff_payload_max_bytes: usize,
}

#[derive(Serialize)]
pub struct LiveCaptureResponse {
    prompts: bool,
    reasoning: bool,
    tool_arguments: bool,
}

pub async fn live_settings_handler(
    State(state): State<Arc<AppState>>,
) -> Json<LiveSettingsResponse> {
    Json(LiveSettingsResponse {
        enabled: state.config.live.enabled,
        codex_mode: state.config.live.codex_mode.as_str(),
        capture: LiveCaptureResponse {
            prompts: state.config.live.capture.prompts,
            reasoning: state.config.live.capture.reasoning,
            tool_arguments: state.config.live.capture.tool_arguments,
        },
        diff_payload_max_bytes: state.config.live.diff_payload_max_bytes,
    })
}
