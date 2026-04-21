use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

#[derive(Debug, Clone)]
pub struct ParsedOtelLogEvent {
    pub session_id: String,
    pub agent_type: String,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub status: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub model: Option<String>,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    pub project: Option<String>,
    pub branch: Option<String>,
    pub client_timestamp: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct ParsedMetricDelta {
    pub session_id: String,
    pub agent_type: String,
    pub model: Option<String>,
    pub tokens_in_delta: i64,
    pub tokens_out_delta: i64,
    pub cache_read_delta: i64,
    pub cache_write_delta: i64,
    pub cost_usd_delta: f64,
}

const CLAUDE_EVENT_MAP: &[(&str, &str)] = &[
    ("claude_code.tool_result", "tool_use"),
    ("claude_code.tool_use", "tool_use"),
    ("claude_code.api_request", "llm_request"),
    ("claude_code.api_response", "llm_response"),
    ("claude_code.session_start", "session_start"),
    ("claude_code.session_end", "session_end"),
    ("claude_code.file_change", "file_change"),
    ("claude_code.git_commit", "git_commit"),
    ("claude_code.plan_step", "plan_step"),
    ("claude_code.error", "error"),
    ("claude_code.user_prompt", "user_prompt"),
    ("claude_code.user_prompt_submit", "user_prompt"),
];

const CODEX_EVENT_MAP: &[(&str, &str)] = &[
    ("codex.tool_result", "tool_use"),
    ("codex.tool_use", "tool_use"),
    ("codex.tool_decision", "tool_use"),
    ("codex.api_request", "llm_request"),
    ("codex.api_response", "llm_response"),
    ("codex.conversation_starts", "session_start"),
    ("codex.session_start", "session_start"),
    ("codex.session_end", "session_end"),
    ("codex.websocket_request", "llm_request"),
    ("codex.file_change", "file_change"),
    ("codex.error", "error"),
    ("codex.user_prompt", "user_prompt"),
    ("codex.user_message", "user_prompt"),
];

const SKIP_EVENTS: &[&str] = &["claude_code.response"];

const SKIPPED_CODEX_WEBSOCKET_RESPONSE_KINDS: &[&str] = &[
    "response.custom_tool_call_input.delta",
    "response.function_call_arguments.delta",
    "response.output_text.delta",
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.done",
    "response.content_part.added",
    "response.content_part.done",
    "response.output_text.done",
    "responsesapi.websocket_timing",
];

const CODEX_RESPONSE_ITEM_TYPES: &[&str] = &[
    "assistant_message",
    "agent_message",
    "message_from_assistant",
    "message_from_user",
    "reasoning",
    "reasoning_summary_delta",
    "reasoning_content_delta",
    "reasoning_summary_part_added",
    "local_shell_call",
    "function_call",
    "function_call_output",
    "tool_search_call",
    "tool_search_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "web_search_call",
    "image_generation_call",
    "ghost_snapshot",
    "compaction",
    "other",
];

const TOKEN_METRICS: &[&str] = &[
    "claude_code.token.usage",
    "codex_cli_rs.token.usage",
    "gen_ai.client.token.usage",
];

const COST_METRICS: &[&str] = &[
    "claude_code.cost.usage",
    "codex_cli_rs.cost.usage",
    "gen_ai.client.cost.usage",
];

fn map_get_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

fn map_get_number(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    })
}

fn map_get_bool(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(|v| match v {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn get_any_string(value: &Value) -> Option<String> {
    if let Some(s) = value.get("stringValue").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(i) = value.get("intValue") {
        if let Some(n) = i.as_i64() {
            return Some(n.to_string());
        }
        if let Some(s) = i.as_str() {
            return Some(s.to_string());
        }
    }
    if let Some(f) = value.get("doubleValue").and_then(|v| v.as_f64()) {
        return Some(f.to_string());
    }
    if let Some(b) = value.get("boolValue").and_then(|v| v.as_bool()) {
        return Some(b.to_string());
    }
    None
}

fn get_any_number(value: &Value) -> Option<f64> {
    if let Some(i) = value.get("intValue") {
        if let Some(n) = i.as_i64() {
            return Some(n as f64);
        }
        if let Some(s) = i.as_str()
            && let Ok(parsed) = s.parse::<f64>()
        {
            return Some(parsed);
        }
    }
    if let Some(f) = value.get("doubleValue").and_then(|v| v.as_f64()) {
        return Some(f);
    }
    if let Some(s) = value.get("stringValue").and_then(|v| v.as_str())
        && let Ok(parsed) = s.parse::<f64>()
    {
        return Some(parsed);
    }
    None
}

fn extract_any_value(v: &Value) -> Value {
    if let Some(s) = v.get("stringValue").and_then(|x| x.as_str()) {
        return Value::String(s.to_string());
    }
    if let Some(i) = v.get("intValue") {
        if let Some(n) = i.as_i64() {
            return Value::Number(n.into());
        }
        if let Some(s) = i.as_str()
            && let Ok(n) = s.parse::<i64>()
        {
            return Value::Number(n.into());
        }
    }
    if let Some(f) = v.get("doubleValue").and_then(|x| x.as_f64())
        && let Some(n) = serde_json::Number::from_f64(f)
    {
        return Value::Number(n);
    }
    if let Some(b) = v.get("boolValue").and_then(|x| x.as_bool()) {
        return Value::Bool(b);
    }
    if let Some(values) = v
        .get("kvlistValue")
        .and_then(|x| x.get("values"))
        .and_then(|x| x.as_array())
    {
        let mut out = Map::new();
        for kv in values {
            if let Some(k) = kv.get("key").and_then(|x| x.as_str())
                && let Some(value) = kv.get("value")
            {
                out.insert(k.to_string(), extract_any_value(value));
            }
        }
        return Value::Object(out);
    }
    if let Some(values) = v
        .get("arrayValue")
        .and_then(|x| x.get("values"))
        .and_then(|x| x.as_array())
    {
        return Value::Array(values.iter().map(extract_any_value).collect());
    }
    Value::Null
}

fn get_attr_value(attrs: Option<&Vec<Value>>, key: &str) -> Option<Value> {
    let attrs = attrs?;
    attrs.iter().find_map(|entry| {
        let k = entry.get("key").and_then(|v| v.as_str())?;
        if k != key {
            return None;
        }
        entry.get("value").cloned()
    })
}

fn get_attr_string(attrs: Option<&Vec<Value>>, key: &str) -> Option<String> {
    get_attr_value(attrs, key).and_then(|v| get_any_string(&v))
}

fn get_attr_number(attrs: Option<&Vec<Value>>, key: &str) -> Option<f64> {
    get_attr_value(attrs, key).and_then(|v| get_any_number(&v))
}

fn get_attr_bool(attrs: Option<&Vec<Value>>, key: &str) -> Option<bool> {
    get_attr_value(attrs, key).and_then(|value| {
        value
            .get("boolValue")
            .and_then(|v| v.as_bool())
            .or_else(|| match value.get("stringValue").and_then(|v| v.as_str()) {
                Some("true") => Some(true),
                Some("false") => Some(false),
                _ => None,
            })
    })
}

fn parse_body_object(body: Option<&Value>) -> Option<Map<String, Value>> {
    let body = body?;

    if let Some(s) = body.get("stringValue").and_then(|v| v.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(s)
            && let Value::Object(map) = parsed
        {
            return Some(map);
        }
        return None;
    }

    if let Some(values) = body
        .get("kvlistValue")
        .and_then(|v| v.get("values"))
        .and_then(|v| v.as_array())
    {
        let mut out = Map::new();
        for kv in values {
            if let Some(k) = kv.get("key").and_then(|v| v.as_str())
                && let Some(value) = kv.get("value")
            {
                out.insert(k.to_string(), extract_any_value(value));
            }
        }
        return Some(out);
    }

    None
}

fn get_map_string(map: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    map.and_then(|value| map_get_string(value, key))
}

fn get_map_number(map: Option<&Map<String, Value>>, key: &str) -> Option<f64> {
    map.and_then(|value| map_get_number(value, key))
}

fn get_map_bool(map: Option<&Map<String, Value>>, key: &str) -> Option<bool> {
    map.and_then(|value| map_get_bool(value, key))
}

fn get_object<'a>(
    map: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    map.and_then(|value| value.get(key))
        .and_then(|value| value.as_object())
}

fn get_codex_payload<'a>(
    body_obj: Option<&'a Map<String, Value>>,
) -> Option<&'a Map<String, Value>> {
    get_object(body_obj, "payload")
}

fn extract_text_from_content(value: &Value) -> Option<String> {
    let Value::Array(items) = value else {
        return None;
    };

    let mut parts = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            continue;
        };
        let text = map_get_string(record, "text")
            .or_else(|| map_get_string(record, "content"))
            .or_else(|| map_get_string(record, "summary"));
        if let Some(text) = text {
            parts.push(text);
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn maybe_parse_json_string(input: &str) -> Value {
    serde_json::from_str(input).unwrap_or_else(|_| Value::String(input.to_string()))
}

fn is_codex_response_item_type(value: &str) -> bool {
    CODEX_RESPONSE_ITEM_TYPES.contains(&value)
}

fn is_skipped_codex_websocket_response_kind(value: &str) -> bool {
    SKIPPED_CODEX_WEBSOCKET_RESPONSE_KINDS.contains(&value)
}

fn nano_to_iso(nanos: Option<&str>) -> Option<String> {
    let nanos = nanos?;
    let as_u128 = nanos.parse::<u128>().ok()?;
    let ms = (as_u128 / 1_000_000) as i64;
    if ms <= 0 {
        return None;
    }
    chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

fn resolve_service_name(resource_attrs: Option<&Vec<Value>>) -> String {
    let service = get_attr_string(resource_attrs, "service.name").unwrap_or_default();
    let sdk = get_attr_string(resource_attrs, "telemetry.sdk.name").unwrap_or_default();
    let combined = format!("{service} {sdk}").to_lowercase();
    if combined.contains("codex") {
        return "codex".to_string();
    }
    if combined.contains("claude") {
        return "claude_code".to_string();
    }
    if !service.is_empty() {
        return service;
    }
    "unknown".to_string()
}

fn get_codex_payload_type(
    log_attrs: Option<&Vec<Value>>,
    body_obj: Option<&Map<String, Value>>,
) -> Option<String> {
    let payload = get_codex_payload(body_obj);
    get_map_string(payload, "type")
        .or_else(|| get_map_string(body_obj, "type"))
        .or_else(|| get_attr_string(log_attrs, "response_item.type"))
        .or_else(|| get_attr_string(log_attrs, "item.type"))
        .or_else(|| get_attr_string(log_attrs, "type"))
}

fn get_codex_event_kind(
    log_attrs: Option<&Vec<Value>>,
    body_obj: Option<&Map<String, Value>>,
) -> Option<String> {
    let payload = get_codex_payload(body_obj);
    get_attr_string(log_attrs, "event.kind")
        .or_else(|| get_attr_string(log_attrs, "kind"))
        .or_else(|| get_map_string(body_obj, "event_kind"))
        .or_else(|| get_map_string(body_obj, "kind"))
        .or_else(|| get_map_string(payload, "event_kind"))
        .or_else(|| get_map_string(payload, "kind"))
}

fn get_codex_error_message(
    log_attrs: Option<&Vec<Value>>,
    body_obj: Option<&Map<String, Value>>,
) -> Option<String> {
    let payload = get_codex_payload(body_obj);
    let nested_error = get_object(body_obj, "error");
    let nested_payload_error = get_object(payload, "error");
    get_attr_string(log_attrs, "error.message")
        .or_else(|| get_map_string(body_obj, "error"))
        .or_else(|| get_map_string(payload, "error"))
        .or_else(|| get_map_string(nested_error, "message"))
        .or_else(|| get_map_string(nested_payload_error, "message"))
}

fn has_codex_transport_failure(
    log_attrs: Option<&Vec<Value>>,
    body_obj: Option<&Map<String, Value>>,
) -> bool {
    get_attr_bool(log_attrs, "success") == Some(false)
        || get_map_bool(body_obj, "success") == Some(false)
        || get_map_bool(get_codex_payload(body_obj), "success") == Some(false)
        || get_codex_error_message(log_attrs, body_obj).is_some()
}

fn map_event_name(agent_type: &str, event_name: &str) -> Option<String> {
    let map = if agent_type == "codex" {
        CODEX_EVENT_MAP
    } else {
        CLAUDE_EVENT_MAP
    };

    if let Some((_, mapped)) = map.iter().find(|(name, _)| *name == event_name) {
        return Some((*mapped).to_string());
    }

    let suffix = event_name.rsplit('.').next().unwrap_or_default();
    match suffix {
        "tool_result" | "tool_use" => Some("tool_use".to_string()),
        "api_request" => Some("llm_request".to_string()),
        "api_response" => Some("llm_response".to_string()),
        "session_start" => Some("session_start".to_string()),
        "session_end" => Some("session_end".to_string()),
        "file_change" => Some("file_change".to_string()),
        "git_commit" => Some("git_commit".to_string()),
        "plan_step" => Some("plan_step".to_string()),
        "error" => Some("error".to_string()),
        "user_prompt" | "user_prompt_submit" => Some("user_prompt".to_string()),
        _ => None,
    }
}

fn resolve_event_type(
    agent_type: &str,
    event_name: Option<&str>,
    severity_text: Option<&str>,
    log_attrs: Option<&Vec<Value>>,
    body_obj: Option<&Map<String, Value>>,
) -> Option<String> {
    if let Some(name) = event_name {
        if let Some(mapped) = map_event_name(agent_type, name) {
            return Some(mapped);
        }

        if agent_type == "codex" {
            let codex_payload_type = get_codex_payload_type(log_attrs, body_obj);
            let codex_event_kind = get_codex_event_kind(log_attrs, body_obj);

            if matches!(name, "codex.response" | "codex.event_msg")
                && matches!(
                    codex_payload_type.as_deref(),
                    Some("user_message" | "user_prompt")
                )
            {
                return Some("user_prompt".to_string());
            }

            if matches!(name, "codex.response" | "codex.event_msg")
                && codex_payload_type
                    .as_deref()
                    .is_some_and(is_codex_response_item_type)
            {
                return Some("response".to_string());
            }

            if name == "codex.sse_event" {
                if codex_event_kind.as_deref() == Some("response.completed") {
                    return Some("llm_response".to_string());
                }
                if codex_event_kind.as_deref() == Some("response.failed")
                    || has_codex_transport_failure(log_attrs, body_obj)
                {
                    return Some("error".to_string());
                }
                if codex_event_kind
                    .as_deref()
                    .is_some_and(|kind| kind.starts_with("response."))
                {
                    return Some("response".to_string());
                }
                return None;
            }

            if matches!(name, "codex.websocket_event" | "codex.websocket.event") {
                if codex_event_kind.as_deref() == Some("response.failed")
                    || has_codex_transport_failure(log_attrs, body_obj)
                {
                    return Some("error".to_string());
                }
                if codex_event_kind
                    .as_deref()
                    .is_some_and(is_skipped_codex_websocket_response_kind)
                {
                    return None;
                }
                if codex_event_kind
                    .as_deref()
                    .is_some_and(|kind| kind.starts_with("response."))
                {
                    return Some("response".to_string());
                }
                return None;
            }
        }

        let suffix = name.rsplit('.').next().unwrap_or_default();
        match suffix {
            "tool_result" | "tool_use" => return Some("tool_use".to_string()),
            "api_request" => return Some("llm_request".to_string()),
            "api_response" => return Some("llm_response".to_string()),
            "session_start" => return Some("session_start".to_string()),
            "session_end" => return Some("session_end".to_string()),
            "file_change" => return Some("file_change".to_string()),
            "git_commit" => return Some("git_commit".to_string()),
            "plan_step" => return Some("plan_step".to_string()),
            "error" => return Some("error".to_string()),
            "user_prompt" | "user_prompt_submit" | "user_message" => {
                return Some("user_prompt".to_string());
            }
            _ => {}
        }
    }

    if agent_type == "codex" {
        let codex_payload_type = get_codex_payload_type(log_attrs, body_obj);
        if matches!(
            codex_payload_type.as_deref(),
            Some("user_message" | "user_prompt")
        ) {
            return Some("user_prompt".to_string());
        }
        if codex_payload_type
            .as_deref()
            .is_some_and(is_codex_response_item_type)
        {
            return Some("response".to_string());
        }
    }

    if severity_text == Some("ERROR") {
        return Some("error".to_string());
    }

    None
}

fn parse_log_record(
    log_record: &Value,
    resource_attrs: Option<&Vec<Value>>,
) -> Option<ParsedOtelLogEvent> {
    let log_attrs = log_record.get("attributes").and_then(|v| v.as_array());
    let event_name = get_attr_string(log_attrs, "event.name");
    if event_name
        .as_deref()
        .is_some_and(|name| SKIP_EVENTS.contains(&name))
    {
        return None;
    }

    let body_obj = parse_body_object(log_record.get("body"));
    let payload = get_codex_payload(body_obj.as_ref());

    let session_id = get_attr_string(log_attrs, "gen_ai.session.id")
        .or_else(|| get_attr_string(log_attrs, "conversation.id"))
        .or_else(|| get_attr_string(resource_attrs, "session.id"))
        .or_else(|| get_attr_string(resource_attrs, "gen_ai.session.id"))
        .or_else(|| get_attr_string(resource_attrs, "conversation.id"))
        .or_else(|| get_map_string(body_obj.as_ref(), "session_id"))?;

    let agent_type = resolve_service_name(resource_attrs);
    let resolved_event_name = event_name.or_else(|| get_attr_string(log_attrs, "name"));
    let event_type = resolve_event_type(
        &agent_type,
        resolved_event_name.as_deref(),
        log_record.get("severityText").and_then(|v| v.as_str()),
        log_attrs,
        body_obj.as_ref(),
    )?;

    let tool_name = get_attr_string(log_attrs, "gen_ai.tool.name")
        .or_else(|| get_attr_string(log_attrs, "tool_name"))
        .or_else(|| get_attr_string(log_attrs, "tool.name"))
        .or_else(|| get_map_string(body_obj.as_ref(), "tool_name"))
        .or_else(|| get_map_string(body_obj.as_ref(), "name"))
        .or_else(|| get_map_string(payload, "tool_name"))
        .or_else(|| get_map_string(payload, "name"));

    let model = get_attr_string(log_attrs, "gen_ai.request.model")
        .or_else(|| get_attr_string(log_attrs, "model"))
        .or_else(|| get_map_string(body_obj.as_ref(), "model"))
        .or_else(|| get_map_string(payload, "model"));

    let tokens_in = get_attr_number(log_attrs, "gen_ai.usage.input_tokens")
        .or_else(|| get_attr_number(log_attrs, "input_token_count"))
        .or_else(|| get_map_number(body_obj.as_ref(), "input_tokens"))
        .or_else(|| get_map_number(body_obj.as_ref(), "input_token_count"))
        .or_else(|| get_map_number(payload, "input_tokens"))
        .or_else(|| get_map_number(payload, "input_token_count"))
        .unwrap_or(0.0) as i64;

    let tokens_out = get_attr_number(log_attrs, "gen_ai.usage.output_tokens")
        .or_else(|| get_attr_number(log_attrs, "output_token_count"))
        .or_else(|| get_map_number(body_obj.as_ref(), "output_tokens"))
        .or_else(|| get_map_number(body_obj.as_ref(), "output_token_count"))
        .or_else(|| get_map_number(payload, "output_tokens"))
        .or_else(|| get_map_number(payload, "output_token_count"))
        .unwrap_or(0.0) as i64;

    let cache_read_tokens = get_attr_number(log_attrs, "gen_ai.usage.cache_read_input_tokens")
        .or_else(|| get_attr_number(log_attrs, "cached_token_count"))
        .or_else(|| get_map_number(body_obj.as_ref(), "cache_read_tokens"))
        .or_else(|| get_map_number(body_obj.as_ref(), "cached_token_count"))
        .or_else(|| get_map_number(body_obj.as_ref(), "cached_input_tokens"))
        .or_else(|| get_map_number(payload, "cache_read_tokens"))
        .or_else(|| get_map_number(payload, "cached_token_count"))
        .or_else(|| get_map_number(payload, "cached_input_tokens"))
        .unwrap_or(0.0) as i64;

    let cache_write_tokens = get_attr_number(log_attrs, "gen_ai.usage.cache_creation_input_tokens")
        .or_else(|| get_map_number(body_obj.as_ref(), "cache_write_tokens"))
        .unwrap_or(0.0) as i64;

    let cost_usd = get_attr_number(log_attrs, "gen_ai.usage.cost")
        .or_else(|| get_map_number(body_obj.as_ref(), "cost_usd"))
        .or_else(|| get_map_number(payload, "cost_usd"));

    let duration_ms = get_attr_number(log_attrs, "gen_ai.latency")
        .or_else(|| get_attr_number(log_attrs, "duration_ms"))
        .or_else(|| get_map_number(body_obj.as_ref(), "duration_ms"))
        .map(|n| n as i64);

    let project = get_attr_string(log_attrs, "project")
        .or_else(|| get_attr_string(resource_attrs, "project"))
        .or_else(|| get_map_string(body_obj.as_ref(), "project"));

    let branch = get_attr_string(log_attrs, "branch")
        .or_else(|| get_attr_string(resource_attrs, "branch"))
        .or_else(|| get_map_string(body_obj.as_ref(), "branch"));

    let client_timestamp = nano_to_iso(log_record.get("timeUnixNano").and_then(|v| v.as_str()));

    let mut metadata = if let Some(mut body_map) = body_obj.clone() {
        let extracted = HashSet::from([
            "session_id",
            "tool_name",
            "model",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "cost_usd",
            "duration_ms",
            "input_token_count",
            "output_token_count",
            "cached_token_count",
            "cached_input_tokens",
            "project",
            "branch",
        ]);

        body_map.retain(|k, _| !extracted.contains(k.as_str()));
        if body_map.is_empty() {
            Value::Object(Map::new())
        } else {
            Value::Object(body_map)
        }
    } else if let Some(message) = log_record
        .get("body")
        .and_then(|b| b.get("stringValue"))
        .and_then(|v| v.as_str())
    {
        json!({ "message": message })
    } else {
        Value::Object(Map::new())
    };

    if let Some(meta) = metadata.as_object_mut() {
        if let Some(name) = resolved_event_name.as_deref() {
            meta.entry("otel_event_name".to_string())
                .or_insert_with(|| Value::String(name.to_string()));
        }

        if agent_type == "codex" {
            let codex_event_kind = get_codex_event_kind(log_attrs, body_obj.as_ref());
            let codex_payload_type = get_codex_payload_type(log_attrs, body_obj.as_ref());
            let error_message = get_codex_error_message(log_attrs, body_obj.as_ref());
            let success = get_attr_bool(log_attrs, "success")
                .or_else(|| get_map_bool(body_obj.as_ref(), "success"))
                .or_else(|| get_map_bool(payload, "success"));

            if let Some(kind) = codex_event_kind.clone() {
                meta.entry("event_kind".to_string())
                    .or_insert_with(|| Value::String(kind));
            }
            if let Some(error_message) = error_message {
                meta.entry("error".to_string())
                    .or_insert_with(|| Value::String(error_message));
            }
            if let Some(success) = success {
                meta.entry("success".to_string())
                    .or_insert(Value::Bool(success));
            }

            if matches!(
                resolved_event_name.as_deref(),
                Some("codex.response" | "codex.event_msg")
            ) && let Some(payload_type) = codex_payload_type
            {
                meta.entry("response_item_type".to_string())
                    .or_insert_with(|| Value::String(payload_type));
            }

            if matches!(
                resolved_event_name.as_deref(),
                Some("codex.tool_result" | "codex.tool_decision")
            ) {
                let arguments_raw = get_attr_string(log_attrs, "arguments")
                    .or_else(|| get_map_string(body_obj.as_ref(), "arguments"))
                    .or_else(|| get_map_string(payload, "arguments"))
                    .or_else(|| get_map_string(body_obj.as_ref(), "input"))
                    .or_else(|| get_map_string(payload, "input"));
                let output_raw = get_attr_string(log_attrs, "output")
                    .or_else(|| get_map_string(body_obj.as_ref(), "output"))
                    .or_else(|| get_map_string(payload, "output"));

                if let Some(call_id) = get_attr_string(log_attrs, "call_id")
                    .or_else(|| get_map_string(body_obj.as_ref(), "call_id"))
                    .or_else(|| get_map_string(payload, "call_id"))
                {
                    meta.entry("call_id".to_string())
                        .or_insert_with(|| Value::String(call_id));
                }
                if let Some(decision) = get_attr_string(log_attrs, "decision")
                    .or_else(|| get_map_string(body_obj.as_ref(), "decision"))
                {
                    meta.entry("decision".to_string())
                        .or_insert_with(|| Value::String(decision));
                }
                if let Some(decision_source) = get_attr_string(log_attrs, "source")
                    .or_else(|| get_map_string(body_obj.as_ref(), "source"))
                {
                    meta.entry("decision_source".to_string())
                        .or_insert_with(|| Value::String(decision_source));
                }
                if let Some(mcp_server) = get_attr_string(log_attrs, "mcp_server")
                    .or_else(|| get_map_string(body_obj.as_ref(), "mcp_server"))
                {
                    meta.entry("mcp_server".to_string())
                        .or_insert_with(|| Value::String(mcp_server));
                }
                if let Some(mcp_server_origin) = get_attr_string(log_attrs, "mcp_server_origin")
                    .or_else(|| get_map_string(body_obj.as_ref(), "mcp_server_origin"))
                {
                    meta.entry("mcp_server_origin".to_string())
                        .or_insert_with(|| Value::String(mcp_server_origin));
                }
                if let Some(arguments) = arguments_raw {
                    meta.entry("arguments".to_string())
                        .or_insert_with(|| maybe_parse_json_string(&arguments));
                }
                if let Some(output) = output_raw {
                    meta.entry("output".to_string())
                        .or_insert_with(|| Value::String(output.clone()));
                    meta.entry("content_preview".to_string())
                        .or_insert_with(|| Value::String(output.chars().take(500).collect()));
                }
            }

            if resolved_event_name.as_deref() == Some("codex.sse_event") {
                if let Some(reasoning_token_count) =
                    get_attr_number(log_attrs, "reasoning_token_count")
                        .or_else(|| get_map_number(body_obj.as_ref(), "reasoning_token_count"))
                {
                    if let Some(number) = serde_json::Number::from_f64(reasoning_token_count) {
                        meta.entry("reasoning_token_count".to_string())
                            .or_insert(Value::Number(number));
                    }
                }
                if let Some(tool_token_count) = get_attr_number(log_attrs, "tool_token_count")
                    .or_else(|| get_map_number(body_obj.as_ref(), "tool_token_count"))
                {
                    if let Some(number) = serde_json::Number::from_f64(tool_token_count) {
                        meta.entry("tool_token_count".to_string())
                            .or_insert(Value::Number(number));
                    }
                }
            }

            if matches!(
                resolved_event_name.as_deref(),
                Some("codex.response" | "codex.event_msg")
            ) {
                let extracted_text = get_map_string(payload, "message")
                    .or_else(|| get_map_string(body_obj.as_ref(), "message"))
                    .or_else(|| get_map_string(payload, "text"))
                    .or_else(|| get_map_string(body_obj.as_ref(), "text"))
                    .or_else(|| {
                        payload
                            .and_then(|value| value.get("content"))
                            .and_then(extract_text_from_content)
                    })
                    .or_else(|| {
                        body_obj
                            .as_ref()
                            .and_then(|value| value.get("content"))
                            .and_then(extract_text_from_content)
                    })
                    .or_else(|| get_map_string(payload, "content_preview"))
                    .or_else(|| get_map_string(body_obj.as_ref(), "content_preview"));

                if event_type == "user_prompt"
                    && let Some(text) = extracted_text.clone()
                {
                    meta.entry("message".to_string())
                        .or_insert_with(|| Value::String(text));
                }
                if event_type == "response"
                    && let Some(text) = extracted_text
                {
                    meta.entry("text".to_string())
                        .or_insert_with(|| Value::String(text.clone()));
                    meta.entry("content_preview".to_string())
                        .or_insert_with(|| Value::String(text.chars().take(500).collect()));
                }
            }
        }
    }

    // For user_prompt events, backfill prompt text from OTEL attributes when body metadata
    // does not already include a message. This matches TypeScript OTEL parser behavior.
    if event_type == "user_prompt" {
        let has_message = metadata
            .get("message")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        if !has_message {
            let prompt_text = get_map_string(body_obj.as_ref(), "message")
                .or_else(|| get_map_string(payload, "message"))
                .or_else(|| get_attr_string(log_attrs, "gen_ai.prompt"))
                .or_else(|| get_attr_string(log_attrs, "message"))
                .or_else(|| get_attr_string(log_attrs, "prompt"))
                .or_else(|| get_attr_string(log_attrs, "codex.prompt"))
                .or_else(|| get_attr_string(log_attrs, "gen_ai.content.prompt"));

            if let Some(prompt_text) = prompt_text {
                match &mut metadata {
                    Value::Object(map) => {
                        map.insert("message".to_string(), Value::String(prompt_text));
                    }
                    _ => {
                        metadata = json!({ "message": prompt_text });
                    }
                }
            }
        }
    }

    let status = if event_type == "error"
        || get_attr_bool(log_attrs, "success") == Some(false)
        || get_map_bool(body_obj.as_ref(), "success") == Some(false)
        || get_map_bool(payload, "success") == Some(false)
    {
        "error".to_string()
    } else {
        "success".to_string()
    };

    Some(ParsedOtelLogEvent {
        session_id,
        agent_type,
        event_type,
        tool_name,
        status,
        tokens_in,
        tokens_out,
        cache_read_tokens,
        cache_write_tokens,
        model,
        cost_usd,
        duration_ms,
        project,
        branch,
        client_timestamp,
        metadata,
    })
}

pub fn parse_otel_logs(payload: &Value) -> Vec<ParsedOtelLogEvent> {
    let mut out = Vec::new();
    let resource_logs = payload
        .get("resourceLogs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for rl in resource_logs {
        let resource_attrs = rl
            .get("resource")
            .and_then(|r| r.get("attributes"))
            .and_then(|v| v.as_array());

        let scope_logs = rl
            .get("scopeLogs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for sl in scope_logs {
            let log_records = sl
                .get("logRecords")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for lr in log_records {
                if let Some(event) = parse_log_record(&lr, resource_attrs) {
                    out.push(event);
                }
            }
        }
    }

    out
}

fn get_data_point_value(dp: &Value) -> f64 {
    if let Some(v) = dp.get("asDouble").and_then(|v| v.as_f64()) {
        return v;
    }
    if let Some(raw) = dp.get("asInt") {
        if let Some(v) = raw.as_i64() {
            return v as f64;
        }
        if let Some(s) = raw.as_str()
            && let Ok(v) = s.parse::<f64>()
        {
            return v;
        }
    }
    0.0
}

fn compute_delta(
    cumulative_state: &mut HashMap<String, f64>,
    key: &str,
    current_value: f64,
) -> f64 {
    let last = cumulative_state.insert(key.to_string(), current_value);
    match last {
        None => current_value,
        Some(prev) => {
            let delta = current_value - prev;
            if delta > 0.0 { delta } else { 0.0 }
        }
    }
}

pub fn parse_otel_metrics(
    payload: &Value,
    cumulative_state: &mut HashMap<String, f64>,
) -> Vec<ParsedMetricDelta> {
    let mut out = Vec::new();

    let resource_metrics = payload
        .get("resourceMetrics")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for rm in resource_metrics {
        let resource_attrs = rm
            .get("resource")
            .and_then(|r| r.get("attributes"))
            .and_then(|v| v.as_array());
        let agent_type = resolve_service_name(resource_attrs);

        let session_id = get_attr_string(resource_attrs, "gen_ai.session.id")
            .or_else(|| get_attr_string(resource_attrs, "session.id"))
            .or_else(|| get_attr_string(resource_attrs, "conversation.id"))
            .unwrap_or_else(|| "unknown".to_string());

        let scope_metrics = rm
            .get("scopeMetrics")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for sm in scope_metrics {
            let metrics = sm
                .get("metrics")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for metric in metrics {
                let metric_name = metric
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if metric_name.is_empty() {
                    continue;
                }

                let is_cumulative = metric
                    .get("sum")
                    .and_then(|s| s.get("aggregationTemporality"))
                    .and_then(|v| v.as_i64())
                    == Some(2);

                let data_points = metric
                    .get("sum")
                    .and_then(|s| s.get("dataPoints"))
                    .or_else(|| metric.get("gauge").and_then(|g| g.get("dataPoints")))
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();

                for dp in data_points {
                    let raw = get_data_point_value(&dp);
                    let dp_attrs = dp.get("attributes").and_then(|v| v.as_array());

                    let model = get_attr_string(dp_attrs, "model")
                        .or_else(|| get_attr_string(dp_attrs, "gen_ai.request.model"))
                        .or_else(|| get_attr_string(resource_attrs, "model"));
                    let token_type = get_attr_string(dp_attrs, "type")
                        .or_else(|| get_attr_string(dp_attrs, "token.type"));

                    let key = format!(
                        "{}|{}|{}|{}|{}",
                        session_id,
                        agent_type,
                        metric_name,
                        model.clone().unwrap_or_default(),
                        token_type.clone().unwrap_or_default()
                    );

                    let delta = if is_cumulative {
                        compute_delta(cumulative_state, &key, raw)
                    } else {
                        raw
                    };

                    if delta <= 0.0 {
                        continue;
                    }

                    if TOKEN_METRICS.contains(&metric_name.as_str()) {
                        let mut entry = ParsedMetricDelta {
                            session_id: session_id.clone(),
                            agent_type: agent_type.clone(),
                            model: model.clone(),
                            tokens_in_delta: 0,
                            tokens_out_delta: 0,
                            cache_read_delta: 0,
                            cache_write_delta: 0,
                            cost_usd_delta: 0.0,
                        };

                        match token_type.as_deref() {
                            Some("input") => entry.tokens_in_delta = delta as i64,
                            Some("output") => entry.tokens_out_delta = delta as i64,
                            Some("cacheRead") | Some("cache_read") => {
                                entry.cache_read_delta = delta as i64
                            }
                            Some("cacheCreation")
                            | Some("cache_creation")
                            | Some("cache_write") => entry.cache_write_delta = delta as i64,
                            _ => entry.tokens_in_delta = delta as i64,
                        }

                        out.push(entry);
                    } else if COST_METRICS.contains(&metric_name.as_str()) {
                        out.push(ParsedMetricDelta {
                            session_id: session_id.clone(),
                            agent_type: agent_type.clone(),
                            model,
                            tokens_in_delta: 0,
                            tokens_out_delta: 0,
                            cache_read_delta: 0,
                            cache_write_delta: 0,
                            cost_usd_delta: delta,
                        });
                    }
                }
            }
        }
    }

    out
}
