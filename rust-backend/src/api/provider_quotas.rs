use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde_json::{Value, json};

use crate::db::queries::{self, ProviderQuotaSnapshotInput};
use crate::state::AppState;

fn parse_claude_statusline_payload(body: &Value) -> Option<ProviderQuotaSnapshotInput> {
    let rate_limits = body.get("rate_limits")?;
    let five_hour = rate_limits.get("five_hour");
    let seven_day = rate_limits.get("seven_day");

    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }

    Some(ProviderQuotaSnapshotInput {
        provider: "claude".to_string(),
        agent_type: "claude_code".to_string(),
        status: "available".to_string(),
        source: Some("claude-statusline".to_string()),
        updated_at: None,
        account_label: None,
        plan_type: None,
        limit_id: None,
        limit_name: None,
        error_message: None,
        primary_used_percent: five_hour
            .and_then(|value| value.get("used_percentage"))
            .and_then(Value::as_f64),
        primary_window_minutes: Some(300),
        primary_resets_at: five_hour
            .and_then(|value| value.get("resets_at"))
            .and_then(Value::as_i64)
            .map(|value| chrono::DateTime::<chrono::Utc>::from_timestamp(value, 0))
            .flatten()
            .map(|value| value.to_rfc3339()),
        secondary_used_percent: seven_day
            .and_then(|value| value.get("used_percentage"))
            .and_then(Value::as_f64),
        secondary_window_minutes: Some(10080),
        secondary_resets_at: seven_day
            .and_then(|value| value.get("resets_at"))
            .and_then(Value::as_i64)
            .map(|value| chrono::DateTime::<chrono::Utc>::from_timestamp(value, 0))
            .flatten()
            .map(|value| value.to_rfc3339()),
        credits_has_credits: None,
        credits_unlimited: None,
        credits_balance: None,
        raw_payload: Some(body.to_string()),
    })
}

pub async fn provider_quotas_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let db = state.db.lock().await;
    match queries::get_usage_monitor(&db) {
        Ok(data) => (StatusCode::OK, Json(json!(data))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}

pub async fn claude_statusline_quota_ingest_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let Some(snapshot) = parse_claude_statusline_payload(&body) else {
        return (StatusCode::ACCEPTED, Json(json!({ "accepted": false, "reason": "missing rate_limits payload" }))).into_response();
    };

    let db = state.db.lock().await;
    match queries::upsert_provider_quota_snapshot(&db, &snapshot) {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({ "accepted": true }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}

pub async fn provider_quota_ingest_handler(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if provider != "claude" && provider != "codex" {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Unknown provider" }))).into_response();
    }

    let snapshot = ProviderQuotaSnapshotInput {
        provider: provider.clone(),
        agent_type: body
            .get("agent_type")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| if provider == "claude" { "claude_code" } else { "codex" }.to_string()),
        status: body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("available")
            .to_string(),
        source: body.get("source").and_then(Value::as_str).map(ToString::to_string),
        updated_at: body.get("updated_at").and_then(Value::as_str).map(ToString::to_string),
        account_label: body.get("account_label").and_then(Value::as_str).map(ToString::to_string),
        plan_type: body.get("plan_type").and_then(Value::as_str).map(ToString::to_string),
        limit_id: body.get("limit_id").and_then(Value::as_str).map(ToString::to_string),
        limit_name: body.get("limit_name").and_then(Value::as_str).map(ToString::to_string),
        error_message: body.get("error_message").and_then(Value::as_str).map(ToString::to_string),
        primary_used_percent: body
            .get("primary")
            .and_then(|value| value.get("used_percent"))
            .and_then(Value::as_f64),
        primary_window_minutes: body
            .get("primary")
            .and_then(|value| value.get("window_minutes"))
            .and_then(Value::as_i64),
        primary_resets_at: body
            .get("primary")
            .and_then(|value| value.get("resets_at"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        secondary_used_percent: body
            .get("secondary")
            .and_then(|value| value.get("used_percent"))
            .and_then(Value::as_f64),
        secondary_window_minutes: body
            .get("secondary")
            .and_then(|value| value.get("window_minutes"))
            .and_then(Value::as_i64),
        secondary_resets_at: body
            .get("secondary")
            .and_then(|value| value.get("resets_at"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        credits_has_credits: body
            .get("credits")
            .and_then(|value| value.get("has_credits"))
            .and_then(Value::as_bool),
        credits_unlimited: body
            .get("credits")
            .and_then(|value| value.get("unlimited"))
            .and_then(Value::as_bool),
        credits_balance: body
            .get("credits")
            .and_then(|value| value.get("balance"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        raw_payload: Some(body.to_string()),
    };

    let db = state.db.lock().await;
    match queries::upsert_provider_quota_snapshot(&db, &snapshot) {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({ "accepted": true }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal server error" })),
        )
            .into_response(),
    }
}
