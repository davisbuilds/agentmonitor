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
    ("codex.session_start", "session_start"),
    ("codex.session_end", "session_end"),
    ("codex.file_change", "file_change"),
    ("codex.error", "error"),
    ("codex.user_prompt", "user_prompt"),
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
) -> Option<String> {
    if let Some(name) = event_name
        && let Some(mapped) = map_event_name(agent_type, name)
    {
        return Some(mapped);
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
    let skip_events: HashSet<&'static str> = HashSet::from([
        "codex.sse_event",
        "codex.websocket.event",
        "claude_code.response",
        "codex.response",
    ]);

    let log_attrs = log_record.get("attributes").and_then(|v| v.as_array());
    let event_name = get_attr_string(log_attrs, "event.name");
    if let Some(name) = event_name.as_deref()
        && skip_events.contains(name)
    {
        return None;
    }

    let body_obj = parse_body_object(log_record.get("body"));

    let session_id = get_attr_string(log_attrs, "gen_ai.session.id")
        .or_else(|| get_attr_string(log_attrs, "conversation.id"))
        .or_else(|| get_attr_string(resource_attrs, "session.id"))
        .or_else(|| get_attr_string(resource_attrs, "gen_ai.session.id"))
        .or_else(|| get_attr_string(resource_attrs, "conversation.id"))
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_string(m, "session_id"))
        })?;

    let agent_type = resolve_service_name(resource_attrs);
    let resolved_event_name = event_name.or_else(|| get_attr_string(log_attrs, "name"));
    let event_type = resolve_event_type(
        &agent_type,
        resolved_event_name.as_deref(),
        log_record.get("severityText").and_then(|v| v.as_str()),
    )?;

    let tool_name = get_attr_string(log_attrs, "gen_ai.tool.name")
        .or_else(|| get_attr_string(log_attrs, "tool_name"))
        .or_else(|| get_attr_string(log_attrs, "tool.name"))
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_string(m, "tool_name"))
        });

    let model = get_attr_string(log_attrs, "gen_ai.request.model")
        .or_else(|| get_attr_string(log_attrs, "model"))
        .or_else(|| body_obj.as_ref().and_then(|m| map_get_string(m, "model")));

    let tokens_in = get_attr_number(log_attrs, "gen_ai.usage.input_tokens")
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_number(m, "input_tokens"))
        })
        .unwrap_or(0.0) as i64;

    let tokens_out = get_attr_number(log_attrs, "gen_ai.usage.output_tokens")
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_number(m, "output_tokens"))
        })
        .unwrap_or(0.0) as i64;

    let cache_read_tokens = get_attr_number(log_attrs, "gen_ai.usage.cache_read_input_tokens")
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_number(m, "cache_read_tokens"))
        })
        .unwrap_or(0.0) as i64;

    let cache_write_tokens = get_attr_number(log_attrs, "gen_ai.usage.cache_creation_input_tokens")
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_number(m, "cache_write_tokens"))
        })
        .unwrap_or(0.0) as i64;

    let cost_usd = get_attr_number(log_attrs, "gen_ai.usage.cost").or_else(|| {
        body_obj
            .as_ref()
            .and_then(|m| map_get_number(m, "cost_usd"))
    });

    let duration_ms = get_attr_number(log_attrs, "gen_ai.latency")
        .or_else(|| get_attr_number(log_attrs, "duration_ms"))
        .or_else(|| {
            body_obj
                .as_ref()
                .and_then(|m| map_get_number(m, "duration_ms"))
        })
        .map(|n| n as i64);

    let project = get_attr_string(log_attrs, "project")
        .or_else(|| get_attr_string(resource_attrs, "project"))
        .or_else(|| body_obj.as_ref().and_then(|m| map_get_string(m, "project")));

    let branch = get_attr_string(log_attrs, "branch")
        .or_else(|| get_attr_string(resource_attrs, "branch"))
        .or_else(|| body_obj.as_ref().and_then(|m| map_get_string(m, "branch")));

    let client_timestamp = nano_to_iso(log_record.get("timeUnixNano").and_then(|v| v.as_str()));

    let metadata = if let Some(mut body_map) = body_obj {
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

    Some(ParsedOtelLogEvent {
        session_id,
        agent_type,
        event_type: event_type.clone(),
        tool_name,
        status: if event_type == "error" {
            "error".to_string()
        } else {
            "success".to_string()
        },
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
