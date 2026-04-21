use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use serde_json::{Value, json};
use tower::ServiceExt;

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::state::AppState;

fn test_app() -> axum::Router {
    let conn = db::initialize(Path::new(":memory:")).expect("in-memory DB");
    let config = Config::from_env();
    let state: Arc<AppState> = AppState::new(conn, config);
    agentmonitor_rs::build_router(state)
}

async fn post_json(app: &axum::Router, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    (status, parsed)
}

async fn post_protobuf(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/x-protobuf")
        .body(Body::from(vec![0x0a, 0x00]))
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    (status, parsed)
}

async fn get_json(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    (status, parsed)
}

fn parse_event_metadata(event: &Value) -> Value {
    if let Some(raw) = event.get("metadata").and_then(|v| v.as_str()) {
        serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}))
    } else {
        event.get("metadata").cloned().unwrap_or_else(|| json!({}))
    }
}

#[tokio::test]
async fn otel_logs_rejects_protobuf() {
    let app = test_app();
    let (status, body) = post_protobuf(&app, "/api/otel/v1/logs").await;
    assert_eq!(status, 415);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn otel_logs_accepts_empty_json() {
    let app = test_app();
    let (status, body) = post_json(&app, "/api/otel/v1/logs", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({}));
}

#[tokio::test]
async fn otel_logs_ingests_mapped_event() {
    let app = test_app();
    let session_id = "otel-logs-sess";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "claude_code" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "claude_code.tool_result" } },
              { "key": "gen_ai.tool.name", "value": { "stringValue": "Bash" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (session_status, body) =
        get_json(&app, "/api/sessions/otel-logs-sess?event_limit=10").await;
    assert_eq!(session_status, 200);
    let events = body["events"].as_array().unwrap();
    assert!(!events.is_empty());
    assert!(events.iter().any(|e| {
        e["event_type"] == "tool_use" && e["tool_name"] == "Bash" && e["source"] == "otel"
    }));
}

#[tokio::test]
async fn otel_logs_user_prompt_extracts_message_from_attributes() {
    let app = test_app();
    let session_id = "otel-codex-prompt-attrs";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.user_prompt" } },
              { "key": "gen_ai.prompt", "value": { "stringValue": "Explain this diff" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-prompt-attrs&event_type=user_prompt",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["message"], "Explain this diff");
}

#[tokio::test]
async fn otel_logs_user_prompt_keeps_existing_message() {
    let app = test_app();
    let session_id = "otel-codex-prompt-existing";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"message\":\"Keep this\",\"kind\":\"body\"}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.user_prompt" } },
              { "key": "gen_ai.prompt", "value": { "stringValue": "Do not overwrite" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-prompt-existing&event_type=user_prompt",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["message"], "Keep this");
    assert_eq!(metadata["kind"], "body");
}

#[tokio::test]
async fn otel_logs_codex_response_user_message_becomes_user_prompt() {
    let app = test_app();
    let session_id = "otel-codex-response-user-message";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"payload\":{\"type\":\"user_message\",\"message\":\"Ship it\"}}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.response" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-response-user-message&event_type=user_prompt",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["otel_event_name"], "codex.response");
    assert_eq!(metadata["response_item_type"], "user_message");
    assert_eq!(metadata["message"], "Ship it");
}

#[tokio::test]
async fn otel_logs_codex_response_assistant_message_is_kept_as_response() {
    let app = test_app();
    let session_id = "otel-codex-response-assistant-message";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"payload\":{\"type\":\"assistant_message\",\"text\":\"Hello from Codex\"}}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.response" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-response-assistant-message&event_type=response",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["response_item_type"], "assistant_message");
    assert_eq!(metadata["text"], "Hello from Codex");
    assert_eq!(metadata["content_preview"], "Hello from Codex");
}

#[tokio::test]
async fn otel_logs_codex_sse_response_completed_becomes_llm_response() {
    let app = test_app();
    let session_id = "otel-codex-sse-completed";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"event_kind\":\"response.completed\",\"input_token_count\":12,\"output_token_count\":4,\"tool_token_count\":16,\"model\":\"gpt-5.4\"}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.sse_event" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-sse-completed&event_type=llm_response",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["tokens_in"], 12);
    assert_eq!(events[0]["tokens_out"], 4);
    assert_eq!(events[0]["model"], "gpt-5.4");
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["event_kind"], "response.completed");
    assert_eq!(metadata["tool_token_count"], 16.0);
}

#[tokio::test]
async fn otel_logs_codex_websocket_failure_becomes_error() {
    let app = test_app();
    let session_id = "otel-codex-websocket-failed";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"event_kind\":\"response.failed\",\"error\":{\"message\":\"socket died\"}}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.websocket_event" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-websocket-failed&event_type=error",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["event_kind"], "response.failed");
    assert_eq!(metadata["error"]["message"], "socket died");
}

#[tokio::test]
async fn otel_logs_codex_websocket_delta_noise_is_skipped() {
    let app = test_app();
    let session_id = "otel-codex-websocket-delta";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"event_kind\":\"response.output_text.delta\",\"success\":true}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.websocket_event" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) =
        get_json(&app, "/api/events?session_id=otel-codex-websocket-delta").await;
    assert_eq!(events_status, 200);
    assert_eq!(body["total"], 0);
    assert_eq!(body["events"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn otel_logs_codex_websocket_skipped_kind_failure_becomes_error() {
    let app = test_app();
    let session_id = "otel-codex-websocket-skipped-failure";
    let payload = json!({
      "resourceLogs": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeLogs": [{
          "logRecords": [{
            "timeUnixNano": "1700000000000000000",
            "body": { "stringValue": "{\"event_kind\":\"response.output_text.delta\",\"success\":false,\"error\":{\"message\":\"socket closed\"}}" },
            "attributes": [
              { "key": "event.name", "value": { "stringValue": "codex.websocket_event" } }
            ]
          }]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/logs", payload).await;
    assert_eq!(status, 200);

    let (events_status, body) = get_json(
        &app,
        "/api/events?session_id=otel-codex-websocket-skipped-failure&event_type=error",
    )
    .await;
    assert_eq!(events_status, 200);

    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"], "error");
    let metadata = parse_event_metadata(&events[0]);
    assert_eq!(metadata["event_kind"], "response.output_text.delta");
    assert_eq!(metadata["success"], false);
    assert_eq!(metadata["error"]["message"], "socket closed");
}

#[tokio::test]
async fn otel_metrics_rejects_protobuf() {
    let app = test_app();
    let (status, _) = post_protobuf(&app, "/api/otel/v1/metrics").await;
    assert_eq!(status, 415);
}

#[tokio::test]
async fn otel_metrics_ingests_synthetic_llm_response_rows() {
    let app = test_app();
    let session_id = "otel-metrics-sess";
    let payload = json!({
      "resourceMetrics": [{
        "resource": {
          "attributes": [
            { "key": "service.name", "value": { "stringValue": "claude_code" } },
            { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
          ]
        },
        "scopeMetrics": [{
          "metrics": [
            {
              "name": "claude_code.token.usage",
              "sum": {
                "dataPoints": [
                  {
                    "asInt": "1000",
                    "attributes": [
                      { "key": "type", "value": { "stringValue": "input" } },
                      { "key": "model", "value": { "stringValue": "claude-sonnet-4-20250514" } }
                    ]
                  },
                  {
                    "asInt": "250",
                    "attributes": [
                      { "key": "type", "value": { "stringValue": "output" } },
                      { "key": "model", "value": { "stringValue": "claude-sonnet-4-20250514" } }
                    ]
                  }
                ],
                "isMonotonic": true,
                "aggregationTemporality": 1
              }
            },
            {
              "name": "claude_code.cost.usage",
              "sum": {
                "dataPoints": [
                  {
                    "asDouble": 0.05,
                    "attributes": [
                      { "key": "model", "value": { "stringValue": "claude-sonnet-4-20250514" } }
                    ]
                  }
                ],
                "isMonotonic": true,
                "aggregationTemporality": 1
              }
            }
          ]
        }]
      }]
    });

    let (status, _) = post_json(&app, "/api/otel/v1/metrics", payload).await;
    assert_eq!(status, 200);

    let (session_status, body) =
        get_json(&app, "/api/sessions/otel-metrics-sess?event_limit=20").await;
    assert_eq!(session_status, 200);

    let events = body["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["event_type"] == "llm_response"));
    assert!(events.iter().any(|e| e["tokens_in"] == 1000));
    assert!(events.iter().any(|e| e["tokens_out"] == 250));
    assert!(
        events
            .iter()
            .any(|e| e["cost_usd"].as_f64().unwrap_or(0.0) > 0.0)
    );
    assert!(events.iter().all(|e| e["source"] == "otel"));
}

#[tokio::test]
async fn otel_metrics_cumulative_to_delta_conversion() {
    let app = test_app();
    let session_id = "otel-cumulative-sess";

    let make_payload = |value: i64| {
        json!({
          "resourceMetrics": [{
            "resource": {
              "attributes": [
                { "key": "service.name", "value": { "stringValue": "claude_code" } },
                { "key": "gen_ai.session.id", "value": { "stringValue": session_id } }
              ]
            },
            "scopeMetrics": [{
              "metrics": [{
                "name": "claude_code.token.usage",
                "sum": {
                  "dataPoints": [{
                    "asInt": value.to_string(),
                    "attributes": [
                      { "key": "type", "value": { "stringValue": "input" } },
                      { "key": "model", "value": { "stringValue": "claude-sonnet-4-20250514" } }
                    ]
                  }],
                  "isMonotonic": true,
                  "aggregationTemporality": 2
                }
              }]
            }]
          }]
        })
    };

    assert_eq!(
        post_json(&app, "/api/otel/v1/metrics", make_payload(1000))
            .await
            .0,
        200
    );
    assert_eq!(
        post_json(&app, "/api/otel/v1/metrics", make_payload(1500))
            .await
            .0,
        200
    );
    assert_eq!(
        post_json(&app, "/api/otel/v1/metrics", make_payload(1500))
            .await
            .0,
        200
    );

    let (_, body) = get_json(&app, "/api/sessions/otel-cumulative-sess?event_limit=20").await;
    let values: Vec<i64> = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["tokens_in"].as_i64())
        .filter(|v| *v > 0)
        .collect();

    assert!(values.contains(&1000));
    assert!(values.contains(&500));
    assert_eq!(values.len(), 2);
}

#[tokio::test]
async fn otel_traces_stub_accepts_json() {
    let app = test_app();
    let (status, body) =
        post_json(&app, "/api/otel/v1/traces", json!({ "resourceSpans": [] })).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({}));
}
