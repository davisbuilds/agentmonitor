use serde_json::Value;

use super::event::{
    EVENT_STATUSES, EVENT_TYPES, NormalizeResult, NormalizedEvent, RawIngestEvent, ValidationError,
};

/// Normalize and validate a raw ingest payload, mirroring TypeScript normalizeIngestEvent().
pub fn normalize_ingest_event(raw: RawIngestEvent) -> NormalizeResult {
    let mut errors = Vec::new();

    let session_id = get_required_string(&raw.session_id, "session_id", &mut errors);
    let agent_type = get_required_string(&raw.agent_type, "agent_type", &mut errors);
    let event_type_raw = get_required_string(&raw.event_type, "event_type", &mut errors);

    // Validate event_type enum
    if !event_type_raw.is_empty() && !EVENT_TYPES.contains(&event_type_raw.as_str()) {
        errors.push(ValidationError {
            field: "event_type".into(),
            message: format!("must be one of: {}", EVENT_TYPES.join(", ")),
        });
    }

    // Validate and default status
    let status = normalize_status(&raw.status, &event_type_raw, &mut errors);

    let event_id = get_optional_string(&raw.event_id, "event_id", &mut errors);
    let tool_name = get_optional_string(&raw.tool_name, "tool_name", &mut errors);
    let branch = get_optional_string(&raw.branch, "branch", &mut errors);
    let project = get_optional_string(&raw.project, "project", &mut errors);
    let model = get_optional_string(&raw.model, "model", &mut errors);
    let duration_ms = get_optional_non_negative_int(&raw.duration_ms, "duration_ms", &mut errors);
    let tokens_in =
        get_optional_non_negative_int(&raw.tokens_in, "tokens_in", &mut errors).unwrap_or(0);
    let tokens_out =
        get_optional_non_negative_int(&raw.tokens_out, "tokens_out", &mut errors).unwrap_or(0);
    let cache_read_tokens =
        get_optional_non_negative_int(&raw.cache_read_tokens, "cache_read_tokens", &mut errors)
            .unwrap_or(0);
    let cache_write_tokens =
        get_optional_non_negative_int(&raw.cache_write_tokens, "cache_write_tokens", &mut errors)
            .unwrap_or(0);
    let cost_usd = get_optional_non_negative_f64(&raw.cost_usd, "cost_usd", &mut errors);
    let client_timestamp = normalize_client_timestamp(&raw.client_timestamp, &mut errors);
    let source = get_optional_string(&raw.source, "source", &mut errors);

    if !errors.is_empty() {
        return NormalizeResult::Err { errors };
    }

    NormalizeResult::Ok {
        event: NormalizedEvent {
            event_id,
            session_id,
            agent_type,
            event_type: event_type_raw,
            tool_name,
            status,
            tokens_in,
            tokens_out,
            branch,
            project,
            duration_ms,
            metadata: raw.metadata.unwrap_or(Value::Object(serde_json::Map::new())),
            client_timestamp,
            model,
            cost_usd,
            cache_read_tokens,
            cache_write_tokens,
            source,
        },
    }
}

/// Validate a raw JSON body (not yet deserialized into RawIngestEvent).
/// Returns NormalizeResult::Err if the body is not a JSON object.
pub fn normalize_from_value(value: Value) -> NormalizeResult {
    if !value.is_object() {
        return NormalizeResult::Err {
            errors: vec![ValidationError {
                field: "body".into(),
                message: "must be a JSON object".into(),
            }],
        };
    }

    match serde_json::from_value::<RawIngestEvent>(value) {
        Ok(raw) => normalize_ingest_event(raw),
        Err(e) => NormalizeResult::Err {
            errors: vec![ValidationError {
                field: "body".into(),
                message: format!("invalid payload: {e}"),
            }],
        },
    }
}

// --- Helper extractors mirroring TypeScript contract helpers ---

fn get_required_string(
    value: &Option<Value>,
    field: &str,
    errors: &mut Vec<ValidationError>,
) -> String {
    match value {
        Some(Value::String(s)) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                errors.push(ValidationError {
                    field: field.into(),
                    message: "must be a non-empty string".into(),
                });
            }
            trimmed
        }
        Some(_) => {
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a string".into(),
            });
            String::new()
        }
        None => {
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a string".into(),
            });
            String::new()
        }
    }
}

fn get_optional_string(
    value: &Option<Value>,
    field: &str,
    errors: &mut Vec<ValidationError>,
) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Some(_) => {
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a string when provided".into(),
            });
            None
        }
    }
}

fn get_optional_non_negative_int(
    value: &Option<Value>,
    field: &str,
    errors: &mut Vec<ValidationError>,
) -> Option<i64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                if i >= 0 {
                    return Some(i);
                }
            }
            // Also accept f64 that is a whole non-negative number
            if let Some(f) = n.as_f64() {
                if f >= 0.0 && f == (f as i64) as f64 {
                    return Some(f as i64);
                }
            }
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a non-negative integer when provided".into(),
            });
            None
        }
        Some(_) => {
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a non-negative integer when provided".into(),
            });
            None
        }
    }
}

fn get_optional_non_negative_f64(
    value: &Option<Value>,
    field: &str,
    errors: &mut Vec<ValidationError>,
) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                if f >= 0.0 {
                    return Some(f);
                }
            }
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a non-negative number when provided".into(),
            });
            None
        }
        Some(_) => {
            errors.push(ValidationError {
                field: field.into(),
                message: "must be a non-negative number when provided".into(),
            });
            None
        }
    }
}

fn normalize_status(
    value: &Option<Value>,
    event_type: &str,
    errors: &mut Vec<ValidationError>,
) -> String {
    let default = if event_type == "error" {
        "error"
    } else {
        "success"
    };

    match value {
        None | Some(Value::Null) => default.into(),
        Some(Value::String(s)) => {
            if !EVENT_STATUSES.contains(&s.as_str()) {
                errors.push(ValidationError {
                    field: "status".into(),
                    message: format!("must be one of: {}", EVENT_STATUSES.join(", ")),
                });
            }
            s.clone()
        }
        Some(_) => {
            errors.push(ValidationError {
                field: "status".into(),
                message: "must be a string when provided".into(),
            });
            default.into()
        }
    }
}

fn normalize_client_timestamp(
    value: &Option<Value>,
    errors: &mut Vec<ValidationError>,
) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            // Basic ISO 8601 validation — accept strings that look like timestamps.
            // Full chrono parsing is available but heavyweight for a spike;
            // we do a length + prefix check that catches obvious garbage.
            if s.len() >= 10 && s.chars().nth(4) == Some('-') {
                Some(s.clone())
            } else {
                errors.push(ValidationError {
                    field: "client_timestamp".into(),
                    message: "must be a valid timestamp".into(),
                });
                None
            }
        }
        Some(_) => {
            errors.push(ValidationError {
                field: "client_timestamp".into(),
                message: "must be an ISO timestamp string when provided".into(),
            });
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn norm(v: Value) -> NormalizeResult {
        normalize_from_value(v)
    }

    // --- Required fields ---

    #[test]
    fn valid_minimal_event_passes() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use"
        }));
        assert!(result.is_ok());
        let evt = result.unwrap_event();
        assert_eq!(evt.session_id, "sess-1");
        assert_eq!(evt.agent_type, "claude_code");
        assert_eq!(evt.event_type, "tool_use");
        assert_eq!(evt.status, "success");
        assert_eq!(evt.tokens_in, 0);
        assert_eq!(evt.tokens_out, 0);
    }

    #[test]
    fn missing_session_id_rejected() {
        let result = norm(json!({
            "agent_type": "claude_code",
            "event_type": "tool_use"
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "session_id"));
    }

    #[test]
    fn missing_agent_type_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "event_type": "tool_use"
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "agent_type"));
    }

    #[test]
    fn missing_event_type_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code"
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "event_type"));
    }

    #[test]
    fn empty_string_session_id_rejected() {
        let result = norm(json!({
            "session_id": "  ",
            "agent_type": "claude_code",
            "event_type": "tool_use"
        }));
        assert!(!result.is_ok());
    }

    #[test]
    fn numeric_session_id_rejected() {
        let result = norm(json!({
            "session_id": 123,
            "agent_type": "claude_code",
            "event_type": "tool_use"
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "session_id" && e.message.contains("string")));
    }

    // --- Enum validation ---

    #[test]
    fn invalid_event_type_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "not_real"
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "event_type" && e.message.contains("must be one of")));
    }

    #[test]
    fn all_valid_event_types_accepted() {
        for et in super::EVENT_TYPES {
            let result = norm(json!({
                "session_id": "sess-1",
                "agent_type": "claude_code",
                "event_type": et
            }));
            assert!(result.is_ok(), "event_type '{et}' should be accepted");
        }
    }

    #[test]
    fn invalid_status_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "status": "pending"
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "status"));
    }

    #[test]
    fn all_valid_statuses_accepted() {
        for s in super::EVENT_STATUSES {
            let result = norm(json!({
                "session_id": "sess-1",
                "agent_type": "claude_code",
                "event_type": "tool_use",
                "status": s
            }));
            assert!(result.is_ok(), "status '{s}' should be accepted");
        }
    }

    // --- Status defaults ---

    #[test]
    fn status_defaults_to_success() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use"
        })).unwrap_event();
        assert_eq!(evt.status, "success");
    }

    #[test]
    fn status_defaults_to_error_for_error_event_type() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "error"
        })).unwrap_event();
        assert_eq!(evt.status, "error");
    }

    #[test]
    fn explicit_status_overrides_default() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "error",
            "status": "timeout"
        })).unwrap_event();
        assert_eq!(evt.status, "timeout");
    }

    // --- Token defaults ---

    #[test]
    fn tokens_default_to_zero() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use"
        })).unwrap_event();
        assert_eq!(evt.tokens_in, 0);
        assert_eq!(evt.tokens_out, 0);
        assert_eq!(evt.cache_read_tokens, 0);
        assert_eq!(evt.cache_write_tokens, 0);
    }

    #[test]
    fn explicit_tokens_preserved() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tokens_in": 100,
            "tokens_out": 50,
            "cache_read_tokens": 25,
            "cache_write_tokens": 10
        })).unwrap_event();
        assert_eq!(evt.tokens_in, 100);
        assert_eq!(evt.tokens_out, 50);
        assert_eq!(evt.cache_read_tokens, 25);
        assert_eq!(evt.cache_write_tokens, 10);
    }

    // --- Negative value rejection ---

    #[test]
    fn negative_tokens_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tokens_in": -5
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "tokens_in"));
    }

    #[test]
    fn negative_cost_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "cost_usd": -1.5
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "cost_usd"));
    }

    #[test]
    fn negative_duration_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "duration_ms": -100
        }));
        assert!(!result.is_ok());
    }

    // --- Type validation for optional fields ---

    #[test]
    fn non_string_tool_name_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": 123
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "tool_name"));
    }

    #[test]
    fn non_number_tokens_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tokens_in": "not a number"
        }));
        assert!(!result.is_ok());
    }

    #[test]
    fn non_string_status_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "status": 42
        }));
        assert!(!result.is_ok());
    }

    // --- Optional fields pass through correctly ---

    #[test]
    fn full_event_with_all_fields() {
        let evt = norm(json!({
            "event_id": "evt-123",
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": "Read",
            "status": "success",
            "tokens_in": 100,
            "tokens_out": 200,
            "branch": "main",
            "project": "myapp",
            "duration_ms": 500,
            "model": "claude-sonnet-4-5-20250514",
            "cost_usd": 0.05,
            "cache_read_tokens": 10,
            "cache_write_tokens": 5,
            "client_timestamp": "2026-02-24T12:00:00Z",
            "source": "hook",
            "metadata": {"command": "cat foo.txt"}
        })).unwrap_event();

        assert_eq!(evt.event_id.as_deref(), Some("evt-123"));
        assert_eq!(evt.tool_name.as_deref(), Some("Read"));
        assert_eq!(evt.branch.as_deref(), Some("main"));
        assert_eq!(evt.project.as_deref(), Some("myapp"));
        assert_eq!(evt.duration_ms, Some(500));
        assert_eq!(evt.model.as_deref(), Some("claude-sonnet-4-5-20250514"));
        assert!((evt.cost_usd.unwrap() - 0.05).abs() < 1e-10);
        assert_eq!(evt.source.as_deref(), Some("hook"));
        assert_eq!(evt.metadata["command"], "cat foo.txt");
    }

    // --- Null optional fields ---

    #[test]
    fn null_optional_fields_accepted() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": null,
            "model": null,
            "cost_usd": null,
            "tokens_in": null,
            "status": null
        }));
        assert!(result.is_ok());
        let evt = result.unwrap_event();
        assert!(evt.tool_name.is_none());
        assert!(evt.model.is_none());
        assert!(evt.cost_usd.is_none());
        assert_eq!(evt.tokens_in, 0);
        assert_eq!(evt.status, "success");
    }

    // --- Metadata ---

    #[test]
    fn metadata_defaults_to_empty_object() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use"
        })).unwrap_event();
        assert!(evt.metadata.is_object());
        assert!(evt.metadata.as_object().unwrap().is_empty());
    }

    // --- Client timestamp ---

    #[test]
    fn valid_timestamp_accepted() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "client_timestamp": "2026-02-24T12:00:00Z"
        })).unwrap_event();
        assert_eq!(evt.client_timestamp.as_deref(), Some("2026-02-24T12:00:00Z"));
    }

    #[test]
    fn garbage_timestamp_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "client_timestamp": "not-a-date"
        }));
        assert!(!result.is_ok());
    }

    #[test]
    fn non_string_timestamp_rejected() {
        let result = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "client_timestamp": 12345
        }));
        assert!(!result.is_ok());
    }

    // --- Non-object bodies ---

    #[test]
    fn string_body_rejected() {
        let result = norm(json!("just a string"));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.iter().any(|e| e.field == "body" && e.message.contains("JSON object")));
    }

    #[test]
    fn array_body_rejected() {
        let result = norm(json!([1, 2, 3]));
        assert!(!result.is_ok());
    }

    #[test]
    fn null_body_rejected() {
        let result = norm(Value::Null);
        assert!(!result.is_ok());
    }

    // --- Whitespace trimming ---

    #[test]
    fn whitespace_trimmed_from_strings() {
        let evt = norm(json!({
            "session_id": "  sess-1  ",
            "agent_type": "  claude_code  ",
            "event_type": "  tool_use  ",
            "tool_name": "  Read  "
        })).unwrap_event();
        assert_eq!(evt.session_id, "sess-1");
        assert_eq!(evt.agent_type, "claude_code");
        assert_eq!(evt.event_type, "tool_use");
        assert_eq!(evt.tool_name.as_deref(), Some("Read"));
    }

    #[test]
    fn whitespace_only_optional_string_becomes_none() {
        let evt = norm(json!({
            "session_id": "sess-1",
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": "   "
        })).unwrap_event();
        assert!(evt.tool_name.is_none());
    }

    // --- Multiple errors accumulated ---

    #[test]
    fn multiple_errors_returned_at_once() {
        let result = norm(json!({
            "session_id": 123,
            "agent_type": true,
            "event_type": 456
        }));
        assert!(!result.is_ok());
        let errors = result.unwrap_errors();
        assert!(errors.len() >= 3, "Expected at least 3 errors, got {}", errors.len());
    }
}
