use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const FULL_CAPABILITIES_JSON: &str =
    r#"{"history":"full","search":"full","tool_analytics":"full","live_items":"full"}"#;

#[derive(Debug, Clone)]
struct ParsedMessage {
    session_id: String,
    ordinal: i64,
    role: String,
    content: String,
    timestamp: Option<String>,
    has_thinking: i64,
    has_tool_use: i64,
    content_length: i64,
}

#[derive(Debug, Clone)]
struct ParsedToolCall {
    session_id: String,
    tool_name: String,
    category: String,
    tool_use_id: Option<String>,
    input_json: Option<String>,
    subagent_session_id: Option<String>,
    message_ordinal: usize,
}

#[derive(Debug, Clone)]
struct ParsedSessionMetadata {
    session_id: String,
    project: Option<String>,
    agent: String,
    first_message: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    message_count: i64,
    user_message_count: i64,
    parent_session_id: Option<String>,
    relationship_type: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedSession {
    messages: Vec<ParsedMessage>,
    tool_calls: Vec<ParsedToolCall>,
    metadata: ParsedSessionMetadata,
}

pub fn sync_claude_history_file(
    conn: &Connection,
    file_path: &Path,
    file_size: i64,
    file_hash: &str,
) -> rusqlite::Result<()> {
    let Ok(jsonl_content) = fs::read_to_string(file_path) else {
        return Ok(());
    };
    let session_id = file_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown");
    let parsed = parse_session_messages(&jsonl_content, session_id, file_path);
    insert_parsed_session(conn, &parsed, file_path, file_size, file_hash)
}

fn categorize_tool_name(tool_name: &str) -> &'static str {
    match tool_name {
        "Read" | "NotebookRead" => "Read",
        "Write" | "NotebookEdit" => "Write",
        "Edit" | "MultiEdit" => "Edit",
        "Grep" | "Glob" | "WebSearch" | "WebFetch" => "Search",
        "Bash" => "Bash",
        "Agent" | "ToolSearch" | "Skill" => "Agent",
        "AskUserQuestion" => "Other",
        _ => "Other",
    }
}

fn parse_session_messages(jsonl_content: &str, session_id: &str, file_path: &Path) -> ParsedSession {
    let mut messages = Vec::new();
    let mut tool_calls = Vec::new();
    let mut first_user_message: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    let mut user_message_count = 0_i64;
    let parent_session_id = None;
    let mut relationship_type = None;
    let mut saw_sidechain = false;

    for raw_line in jsonl_content.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(line) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let line_type = line.get("type").and_then(Value::as_str).unwrap_or_default();
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            saw_sidechain = true;
        }
        if line_type != "user" && line_type != "assistant" {
            continue;
        }

        let Some(message) = line.get("message").and_then(Value::as_object) else {
            continue;
        };
        let Some(role) = message.get("role").and_then(Value::as_str) else {
            continue;
        };
        let Some(raw_content) = message.get("content") else {
            continue;
        };

        let blocks = if let Some(content) = raw_content.as_str() {
            vec![json!({ "type": "text", "text": content })]
        } else if let Some(content) = raw_content.as_array() {
            content.clone()
        } else {
            continue;
        };

        let mut normalized_blocks: Vec<Value> = Vec::new();
        let mut has_thinking = false;
        let mut has_tool_use = false;

        for block in blocks {
            let Some(block_type) = block.get("type").and_then(Value::as_str) else {
                continue;
            };

            match block_type {
                "text" => normalized_blocks.push(json!({
                    "type": "text",
                    "text": block.get("text").and_then(Value::as_str).unwrap_or_default(),
                })),
                "thinking" => {
                    normalized_blocks.push(json!({
                        "type": "thinking",
                        "text": block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .or_else(|| block.get("text").and_then(Value::as_str))
                            .unwrap_or_default(),
                    }));
                    has_thinking = true;
                }
                "tool_use" => {
                    normalized_blocks.push(json!({
                        "type": "tool_use",
                        "id": block.get("id").cloned().unwrap_or(Value::Null),
                        "name": block.get("name").cloned().unwrap_or(Value::Null),
                        "input": block.get("input").cloned().unwrap_or(Value::Null),
                    }));
                    has_tool_use = true;

                    if let Some(tool_name) = block.get("name").and_then(Value::as_str) {
                        tool_calls.push(ParsedToolCall {
                            session_id: session_id.to_string(),
                            tool_name: tool_name.to_string(),
                            category: categorize_tool_name(tool_name).to_string(),
                            tool_use_id: block
                                .get("id")
                                .and_then(Value::as_str)
                                .map(ToString::to_string),
                            input_json: block.get("input").map(Value::to_string),
                            subagent_session_id: block.get("input").and_then(extract_subagent_session_id),
                            message_ordinal: messages.len(),
                        });
                    }
                }
                "tool_result" => normalized_blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                    "content": block.get("content").cloned().unwrap_or(Value::Null),
                    "is_error": block.get("is_error").cloned().unwrap_or(Value::Null),
                })),
                _ => normalized_blocks.push(block),
            }
        }

        let content = serde_json::to_string(&normalized_blocks).unwrap_or_else(|_| "[]".to_string());
        let timestamp = line
            .get("timestamp")
            .and_then(Value::as_str)
            .map(ToString::to_string);

        if let Some(ts) = timestamp.as_ref() {
            if started_at.as_ref().is_none_or(|current| ts < current) {
                started_at = Some(ts.clone());
            }
            if ended_at.as_ref().is_none_or(|current| ts > current) {
                ended_at = Some(ts.clone());
            }
        }

        if role == "user" {
            user_message_count += 1;
            if first_user_message.is_none() {
                first_user_message = preview_text_from_blocks(
                    &normalized_blocks,
                    line.get("isMeta").and_then(Value::as_bool) == Some(true),
                );
            }
        }

        messages.push(ParsedMessage {
            session_id: session_id.to_string(),
            ordinal: messages.len() as i64,
            role: role.to_string(),
            content_length: content.len() as i64,
            content,
            timestamp,
            has_thinking: if has_thinking { 1 } else { 0 },
            has_tool_use: if has_tool_use { 1 } else { 0 },
        });
    }

    let project = project_from_path(file_path);
    if session_id.starts_with("agent-") {
        relationship_type = Some("subagent".to_string());
    } else if saw_sidechain {
        relationship_type = Some("sidechain".to_string());
    }

    ParsedSession {
        messages,
        tool_calls,
        metadata: ParsedSessionMetadata {
            session_id: session_id.to_string(),
            project,
            agent: "claude".to_string(),
            first_message: first_user_message,
            started_at,
            ended_at: ended_at.clone(),
            message_count: 0,
            user_message_count,
            parent_session_id,
            relationship_type,
        },
    }
    .with_message_count()
}

trait ParsedSessionExt {
    fn with_message_count(self) -> ParsedSession;
}

impl ParsedSessionExt for ParsedSession {
    fn with_message_count(mut self) -> ParsedSession {
        self.metadata.message_count = self.messages.len() as i64;
        self
    }
}

fn insert_parsed_session(
    conn: &Connection,
    parsed: &ParsedSession,
    file_path: &Path,
    file_size: i64,
    file_hash: &str,
) -> rusqlite::Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;

    let result = (|| -> rusqlite::Result<()> {
        let metadata = &parsed.metadata;
        conn.execute("DELETE FROM tool_calls WHERE session_id = ?1", [&metadata.session_id])?;
        conn.execute("DELETE FROM messages WHERE session_id = ?1", [&metadata.session_id])?;
        conn.execute(
            "DELETE FROM browsing_sessions WHERE id = ?1",
            [&metadata.session_id],
        )?;

        let last_item_at = metadata.ended_at.clone().or_else(|| metadata.started_at.clone());
        let live_status = derive_live_status(last_item_at.as_deref());

        conn.execute(
            "INSERT INTO browsing_sessions (
                id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
                parent_session_id, relationship_type, live_status, last_item_at, integration_mode,
                fidelity, capabilities_json, file_path, file_size, file_hash
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'claude-jsonl', 'full', ?13, ?14, ?15, ?16
            )",
            params![
                metadata.session_id,
                metadata.project,
                metadata.agent,
                metadata.first_message,
                metadata.started_at,
                metadata.ended_at,
                metadata.message_count,
                metadata.user_message_count,
                metadata.parent_session_id,
                metadata.relationship_type,
                live_status,
                last_item_at,
                FULL_CAPABILITIES_JSON,
                file_path.display().to_string(),
                file_size,
                file_hash,
            ],
        )?;

        let mut message_ids = Vec::with_capacity(parsed.messages.len());
        for message in &parsed.messages {
            conn.execute(
                "INSERT INTO messages (
                    session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    message.session_id,
                    message.ordinal,
                    message.role,
                    message.content,
                    message.timestamp,
                    message.has_thinking,
                    message.has_tool_use,
                    message.content_length,
                ],
            )?;
            message_ids.push(conn.last_insert_rowid());
        }

        let mut subagent_session_ids = HashSet::new();
        for tool_call in &parsed.tool_calls {
            let Some(message_id) = message_ids.get(tool_call.message_ordinal).copied() else {
                continue;
            };
            conn.execute(
                "INSERT INTO tool_calls (
                    message_id, session_id, tool_name, category, tool_use_id, input_json, subagent_session_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    message_id,
                    tool_call.session_id,
                    tool_call.tool_name,
                    tool_call.category,
                    tool_call.tool_use_id,
                    tool_call.input_json,
                    tool_call.subagent_session_id,
                ],
            )?;
            if let Some(child_id) = tool_call.subagent_session_id.as_ref() {
                subagent_session_ids.insert(child_id.clone());
            }
        }

        link_parsed_session_relationships(conn, &metadata.session_id, subagent_session_ids)?;
        upsert_watched_file(conn, file_path, file_hash)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

fn derive_live_status(last_item_at: Option<&str>) -> String {
    let Some(last_item_at) = last_item_at else {
        return "available".to_string();
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(last_item_at) else {
        return "available".to_string();
    };
    let diff_ms = Utc::now()
        .signed_duration_since(parsed.with_timezone(&Utc))
        .num_milliseconds();
    if diff_ms <= 5 * 60_000 {
        "live".to_string()
    } else if diff_ms <= 15 * 60_000 {
        "active".to_string()
    } else {
        "ended".to_string()
    }
}

fn clean_preview_text(text: &str) -> String {
    strip_ansi_sequences(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn preview_text_from_blocks(blocks: &[Value], is_meta: bool) -> Option<String> {
    if is_meta {
        return None;
    }
    let text = blocks.iter().find_map(|block| {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        block.get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })?;

    if text.contains("<local-command-caveat>")
        || text.contains("<command-name>")
        || text.contains("<local-command-stdout>")
        || text.contains("<local-command-stderr>")
    {
        return None;
    }

    let cleaned = clean_preview_text(&text);
    if cleaned.is_empty() {
        None
    } else {
        Some(slice_chars(&cleaned, 200))
    }
}

fn project_from_path(file_path: &Path) -> Option<String> {
    let parts = file_path
        .iter()
        .map(|part| part.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let projects_idx = parts.iter().position(|part| part == "projects")?;
    let encoded_dir = parts.get(projects_idx + 1)?;
    let remainder = encoded_dir
        .strip_prefix("-Users-")
        .or_else(|| encoded_dir.strip_prefix("-home-"))?;
    let without_user = remainder.split_once('-').map(|(_, rest)| rest)?;
    let known_dirs = [
        "Dev",
        "Documents",
        "Projects",
        "repos",
        "code",
        "src",
        "work",
        "projects",
        "workspace",
        "git",
    ];
    for dir in known_dirs {
        let marker = format!("{dir}-");
        if let Some(index) = without_user.find(&marker) {
            return Some(without_user[index + marker.len()..].to_string());
        }
    }
    Some(without_user.to_string())
}

fn extract_subagent_session_id(input: &Value) -> Option<String> {
    let mut queue = VecDeque::from([input]);
    while let Some(current) = queue.pop_front() {
        match current {
            Value::String(value) => {
                let trimmed = value.trim();
                if is_agent_session_id(trimmed) {
                    return Some(trimmed.to_string());
                }
            }
            Value::Array(items) => {
                for item in items {
                    queue.push_back(item);
                }
            }
            Value::Object(record) => {
                for (key, value) in record {
                    if matches!(key.as_str(), "session_id" | "sessionId" | "subagent_id")
                        && value.as_str().is_some_and(is_agent_session_id)
                    {
                        return value.as_str().map(ToString::to_string);
                    }
                    queue.push_back(value);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_agent_session_id(value: &str) -> bool {
    value.starts_with("agent-")
        && value
            .chars()
            .skip("agent-".len())
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn link_parsed_session_relationships(
    conn: &Connection,
    session_id: &str,
    subagent_session_ids: HashSet<String>,
) -> rusqlite::Result<()> {
    for child_id in subagent_session_ids {
        conn.execute(
            "UPDATE browsing_sessions
             SET parent_session_id = ?1,
                 relationship_type = 'subagent'
             WHERE id = ?2",
            params![session_id, child_id],
        )?;
    }

    let parent = conn
        .query_row(
            "SELECT session_id
             FROM tool_calls
             WHERE subagent_session_id = ?1
             ORDER BY id DESC
             LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    if let Some(parent_id) = parent {
        conn.execute(
            "UPDATE browsing_sessions
             SET parent_session_id = ?1,
                 relationship_type = 'subagent'
             WHERE id = ?2",
            params![parent_id, session_id],
        )?;
    }

    Ok(())
}

fn upsert_watched_file(conn: &Connection, file_path: &Path, file_hash: &str) -> rusqlite::Result<()> {
    let file_mtime = fs::metadata(file_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(system_time_to_rfc3339);
    conn.execute(
        "INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
         VALUES (?1, ?2, ?3, 'parsed', datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           file_hash = excluded.file_hash,
           file_mtime = excluded.file_mtime,
           status = excluded.status,
           last_parsed_at = datetime('now')",
        params![file_path.display().to_string(), file_hash, file_mtime],
    )?;
    Ok(())
}

fn system_time_to_rfc3339(time: SystemTime) -> Option<String> {
    let dt: DateTime<Utc> = time.into();
    Some(dt.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{001b}' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(next) = chars.next() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
            continue;
        }
        result.push(ch);
    }
    result
}

fn slice_chars(input: &str, max_chars: usize) -> String {
    input.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::project_from_path;
    use std::path::Path;

    #[test]
    fn derives_project_name_from_claude_path() {
        let path = Path::new(
            "/Users/dg/.claude/projects/-Users-dg-mac-mini-Dev-agentmonitor/session.jsonl",
        );
        assert_eq!(project_from_path(path).as_deref(), Some("agentmonitor"));
    }
}
