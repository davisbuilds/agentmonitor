use serde_json::{Map, Value};

/// Priority keys to preserve when building a truncated metadata summary.
/// Mirrors METADATA_PRIORITY_KEYS in TypeScript queries.ts.
const PRIORITY_KEYS: &[&str] = &[
    "command",
    "file_path",
    "query",
    "pattern",
    "error",
    "message",
    "tool_name",
    "path",
    "type",
];

pub struct TruncateResult {
    pub value: String,
    pub truncated: bool,
}

/// UTF-8 safe byte truncation — mirrors TypeScript utf8SliceByBytes().
/// Slices the string at the last valid char boundary that fits within max_bytes.
fn utf8_slice_by_bytes(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }
    // Find the last char boundary at or before max_bytes
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

/// Build a truncation summary preserving priority keys from an object.
fn build_truncated_object_summary(obj: &Map<String, Value>, original_bytes: usize) -> String {
    let mut summary = Map::new();
    summary.insert("_truncated".into(), Value::Bool(true));
    summary.insert(
        "_original_bytes".into(),
        Value::Number(serde_json::Number::from(original_bytes)),
    );

    for &key in PRIORITY_KEYS {
        if let Some(val) = obj.get(key) {
            summary.insert(key.into(), val.clone());
        }
    }

    serde_json::to_string(&Value::Object(summary)).unwrap_or_else(|_| {
        r#"{"_serialization_error":true}"#.into()
    })
}

/// Build a generic truncation summary (non-object metadata).
fn build_truncated_generic_summary(original_bytes: usize) -> String {
    serde_json::to_string(&serde_json::json!({
        "_truncated": true,
        "_original_bytes": original_bytes,
    }))
    .unwrap()
}

/// Truncate metadata to fit within max_payload_kb, mirroring TypeScript truncateMetadata().
pub fn truncate_metadata(metadata: &Value, max_payload_kb: usize) -> TruncateResult {
    let max_bytes = max_payload_kb * 1024;

    // If metadata is a string value, truncate the raw string
    if let Value::String(s) = metadata {
        let byte_len = s.len();
        if byte_len <= max_bytes {
            return TruncateResult {
                value: s.clone(),
                truncated: false,
            };
        }
        return TruncateResult {
            value: utf8_slice_by_bytes(s, max_bytes).to_string(),
            truncated: true,
        };
    }

    let serialized = serde_json::to_string(metadata).unwrap_or_else(|_| {
        r#"{"_serialization_error":true}"#.into()
    });
    let byte_len = serialized.len();

    if byte_len <= max_bytes {
        return TruncateResult {
            value: serialized,
            truncated: false,
        };
    }

    // Build summary
    let summary = if let Value::Object(obj) = metadata {
        build_truncated_object_summary(obj, byte_len)
    } else {
        build_truncated_generic_summary(byte_len)
    };

    if summary.len() <= max_bytes {
        return TruncateResult {
            value: summary,
            truncated: true,
        };
    }

    // Summary itself is too large — byte-slice it
    TruncateResult {
        value: utf8_slice_by_bytes(&summary, max_bytes).to_string(),
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn small_metadata_passes_through() {
        let meta = json!({"command": "ls"});
        let result = truncate_metadata(&meta, 10); // 10 KB
        assert!(!result.truncated);
        assert_eq!(result.value, r#"{"command":"ls"}"#);
    }

    #[test]
    fn oversized_object_produces_summary_with_priority_keys() {
        let mut obj = serde_json::Map::new();
        obj.insert("command".into(), json!("important-cmd"));
        obj.insert("file_path".into(), json!("/a/b/c"));
        // Add a large field to exceed 1 KB limit
        obj.insert("big_field".into(), json!("x".repeat(2000)));

        let result = truncate_metadata(&Value::Object(obj), 1);
        assert!(result.truncated);
        let parsed: Value = serde_json::from_str(&result.value).unwrap();
        assert_eq!(parsed["_truncated"], json!(true));
        assert_eq!(parsed["command"], json!("important-cmd"));
        assert_eq!(parsed["file_path"], json!("/a/b/c"));
        assert!(parsed.get("big_field").is_none());
    }

    #[test]
    fn string_metadata_truncated_utf8_safe() {
        // 3-byte UTF-8 chars
        let input = "aaaa\u{1F600}bbbb"; // emoji is 4 bytes
        let meta = Value::String(input.to_string());
        // Allow only 6 bytes: "aaaa" fits (4 bytes), emoji doesn't (needs 4 more)
        let result = truncate_metadata(&meta, 0); // 0 KB = 0 bytes max
        assert!(result.truncated);
        assert!(result.value.is_empty());
    }

    #[test]
    fn utf8_slice_does_not_split_multibyte() {
        let s = "hello\u{00E9}world"; // é is 2 bytes
        // "hello" = 5 bytes, "é" = 2 bytes = 7 total
        // cutting at 6 can't fit é (needs byte 5+6), so stops at 5
        let sliced = utf8_slice_by_bytes(s, 6);
        assert_eq!(sliced, "hello");
        // cutting at 7 fits é
        let sliced = utf8_slice_by_bytes(s, 7);
        assert_eq!(sliced, "hello\u{00E9}");
    }

    #[test]
    fn zero_max_returns_empty_for_string() {
        let meta = Value::String("anything".into());
        let result = truncate_metadata(&meta, 0);
        assert!(result.truncated);
        assert!(result.value.is_empty());
    }
}
