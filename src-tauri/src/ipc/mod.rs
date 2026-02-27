use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub mode: String,
    pub backend_transport: String,
    pub ipc_enabled: bool,
}

#[tauri::command]
pub fn desktop_runtime_status() -> DesktopRuntimeStatus {
    DesktopRuntimeStatus {
        mode: "internal-first-http".to_string(),
        backend_transport: "http".to_string(),
        ipc_enabled: false,
    }
}

#[cfg(test)]
mod tests {
    use super::desktop_runtime_status;

    #[test]
    fn desktop_runtime_status_is_http_first_until_ipc_slice_lands() {
        let status = desktop_runtime_status();
        assert_eq!(status.mode, "internal-first-http");
        assert_eq!(status.backend_transport, "http");
        assert!(!status.ipc_enabled);
    }
}
