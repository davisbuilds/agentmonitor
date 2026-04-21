use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::Value;

use crate::config::InsightsProvider;
use crate::db::v2_queries::{InsightsListParams, delete_insight, get_insight, list_insights};
use crate::insights::service::{
    GenerateInsightParams, InsightKind, generate_insight, generation_metadata,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct InsightsQuery {
    date_from: Option<String>,
    date_to: Option<String>,
    project: Option<String>,
    agent: Option<String>,
    kind: Option<String>,
    limit: Option<String>,
}

fn parse_i64(input: Option<&str>) -> Option<i64> {
    input.and_then(|raw| raw.parse::<i64>().ok())
}

fn parse_kind(raw: &str) -> Option<InsightKind> {
    match raw {
        "overview" => Some(InsightKind::Overview),
        "workflow" => Some(InsightKind::Workflow),
        "usage" => Some(InsightKind::Usage),
        _ => None,
    }
}

fn parse_provider(raw: &str) -> Option<InsightsProvider> {
    match raw {
        "openai" => Some(InsightsProvider::OpenAi),
        "anthropic" => Some(InsightsProvider::Anthropic),
        "gemini" => Some(InsightsProvider::Gemini),
        _ => None,
    }
}

pub async fn list_insights_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<InsightsQuery>,
) -> impl IntoResponse {
    let kind = match query.kind.as_deref() {
        Some(raw) => match parse_kind(raw) {
            Some(kind) => Some(kind.as_str().to_string()),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "Invalid insight kind" })),
                )
                    .into_response();
            }
        },
        None => None,
    };

    let db = state.db.lock().await;
    match list_insights(
        &db,
        &InsightsListParams {
            date_from: query.date_from,
            date_to: query.date_to,
            project: query.project,
            agent: query.agent,
            kind,
            limit: parse_i64(query.limit.as_deref()),
        },
    ) {
        Ok(data) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "data": data,
                "generation": generation_metadata(&state),
            })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to list insights" })),
        )
            .into_response(),
    }
}

pub async fn get_insight_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(id) = id.parse::<i64>().ok() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid insight id" })),
        )
            .into_response();
    };

    let db = state.db.lock().await;
    match get_insight(&db, id) {
        Ok(Some(insight)) => (StatusCode::OK, Json(insight)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Insight not found" })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to get insight" })),
        )
            .into_response(),
    }
}

pub async fn generate_insight_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let kind = match body
        .get("kind")
        .and_then(Value::as_str)
        .and_then(parse_kind)
    {
        Some(kind) => kind,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::json!({ "error": "kind must be one of overview, workflow, or usage" }),
                ),
            )
                .into_response();
        }
    };

    let Some(date_from) = body.get("date_from").and_then(Value::as_str) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "date_from and date_to are required" })),
        )
            .into_response();
    };
    let Some(date_to) = body.get("date_to").and_then(Value::as_str) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "date_from and date_to are required" })),
        )
            .into_response();
    };

    let project = match body.get("project") {
        Some(Value::String(value)) => {
            Some(value.trim().to_string()).filter(|value| !value.is_empty())
        }
        Some(Value::Null) | None => None,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "project must be a string" })),
            )
                .into_response();
        }
    };

    let agent = match body.get("agent") {
        Some(Value::String(value)) => {
            Some(value.trim().to_string()).filter(|value| !value.is_empty())
        }
        Some(Value::Null) | None => None,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "agent must be a string" })),
            )
                .into_response();
        }
    };

    let prompt = match body.get("prompt") {
        Some(Value::String(value)) => {
            Some(value.trim().to_string()).filter(|value| !value.is_empty())
        }
        Some(Value::Null) | None => None,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "prompt must be a string" })),
            )
                .into_response();
        }
    };

    let provider = match body.get("provider") {
        Some(Value::String(value)) => match parse_provider(value) {
            Some(provider) => Some(provider),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        serde_json::json!({ "error": "provider must be one of openai, anthropic, or gemini" }),
                    ),
                )
                    .into_response();
            }
        },
        Some(Value::Null) | None => None,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::json!({ "error": "provider must be one of openai, anthropic, or gemini" }),
                ),
            )
                .into_response();
        }
    };

    let model = match body.get("model") {
        Some(Value::String(value)) => {
            Some(value.trim().to_string()).filter(|value| !value.is_empty())
        }
        Some(Value::Null) | None => None,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "model must be a string" })),
            )
                .into_response();
        }
    };

    match generate_insight(
        state,
        GenerateInsightParams {
            kind,
            date_from: date_from.to_string(),
            date_to: date_to.to_string(),
            project,
            agent,
            prompt,
            provider,
            model,
        },
    )
    .await
    {
        Ok(insight) => (StatusCode::CREATED, Json(insight)).into_response(),
        Err(message) => {
            let status = if message.contains("required") || message.contains("must be") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(serde_json::json!({ "error": message }))).into_response()
        }
    }
}

pub async fn delete_insight_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(id) = id.parse::<i64>().ok() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid insight id" })),
        )
            .into_response();
    };

    let db = state.db.lock().await;
    match delete_insight(&db, id) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({ "removed": true }))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Insight not found" })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to delete insight" })),
        )
            .into_response(),
    }
}
