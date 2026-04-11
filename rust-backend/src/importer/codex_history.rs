use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const SUMMARY_CAPABILITIES_JSON: &str =
    r#"{"history":"summary","search":"summary","tool_analytics":"summary","live_items":"summary"}"#;

#[derive(Debug, Clone)]
struct ParsedMessage {
    session_id: String,
    ordinal: i64,
    role: String,
    content: String,
    blocks: Vec<Value>,
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
}

#[derive(Debug)]
struct ParsedSession {
    messages: Vec<ParsedMessage>,
    tool_calls: Vec<ParsedToolCall>,
    metadata: ParsedSessionMetadata,
}

pub fn sync_codex_history_file(
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
    let parsed = parse_codex_session_messages(&jsonl_content, session_id);
    if parsed.messages.is_empty() {
        return Ok(());
    }
    insert_parsed_session(conn, &parsed, file_path, file_size, file_hash)
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(ToString::to_string)
}

fn parse_codex_session_messages(jsonl_content: &str, session_id: &str) -> ParsedSession {
    let mut messages: Vec<ParsedMessage> = Vec::new();
    let mut tool_calls: Vec<ParsedToolCall> = Vec::new();
    let mut first_user_message: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    let mut user_message_count = 0_i64;
    let mut cwd: Option<String> = None;

    let lines: Vec<Value> = jsonl_content
        .lines()
        .filter_map(|raw| serde_json::from_str(raw).ok())
        .collect();

    // Extract session metadata
    for line in &lines {
        if get_string(line, "type").as_deref() == Some("session_meta") {
            let payload = line.get("payload").unwrap_or(&Value::Null);
            cwd = get_string(payload, "cwd");
            started_at = get_string(payload, "timestamp")
                .or_else(|| get_string(line, "timestamp"));
            break;
        }
    }

    // Process response_item lines as messages
    for line in &lines {
        let timestamp = get_string(line, "timestamp");

        if let Some(ts) = timestamp.as_ref() {
            if started_at.as_ref().is_none_or(|current| ts < current) {
                started_at = Some(ts.clone());
            }
            if ended_at.as_ref().is_none_or(|current| ts > current) {
                ended_at = Some(ts.clone());
            }
        }

        if get_string(line, "type").as_deref() != Some("response_item") {
            continue;
        }
        let payload = line.get("payload").unwrap_or(&Value::Null);
        let role = get_string(payload, "role");
        let tool_name = get_string(payload, "name");

        // Tool call response_item (no role, has name + input)
        if let Some(ref tool_name) = tool_name {
            if role.is_none() {
                let input = payload.get("input");
                let blocks = vec![json!({
                    "type": "tool_use",
                    "name": tool_name,
                    "input": input.cloned().unwrap_or(Value::Null),
                })];

                let category = if tool_name == "apply_patch" { "Edit" } else { "Other" };
                tool_calls.push(ParsedToolCall {
                    session_id: session_id.to_string(),
                    tool_name: tool_name.clone(),
                    category: category.to_string(),
                    tool_use_id: None,
                    input_json: input.map(Value::to_string),
                    message_ordinal: messages.len(),
                });

                let content = serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".to_string());
                messages.push(ParsedMessage {
                    session_id: session_id.to_string(),
                    ordinal: messages.len() as i64,
                    role: "assistant".to_string(),
                    content_length: content.len() as i64,
                    content,
                    blocks,
                    timestamp,
                    has_thinking: 0,
                    has_tool_use: 1,
                });
                continue;
            }
        }

        // Regular message with role + content
        let Some(role) = role else { continue };
        let Some(content_arr) = payload.get("content").and_then(Value::as_array) else {
            continue;
        };

        let mut blocks: Vec<Value> = Vec::new();
        for block in content_arr {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                blocks.push(json!({
                    "type": "text",
                    "text": block.get("text").and_then(Value::as_str).unwrap_or_default(),
                }));
            }
        }
        if blocks.is_empty() {
            continue;
        }

        if role == "user" {
            user_message_count += 1;
            if first_user_message.is_none() {
                first_user_message = blocks
                    .first()
                    .and_then(|b| b.get("text"))
                    .and_then(Value::as_str)
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
                    .map(|t| if t.len() > 200 { t[..200].to_string() } else { t });
            }
        }

        let content = serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".to_string());
        messages.push(ParsedMessage {
            session_id: session_id.to_string(),
            ordinal: messages.len() as i64,
            role,
            content_length: content.len() as i64,
            content,
            blocks,
            timestamp,
            has_thinking: 0,
            has_tool_use: 0,
        });
    }

    let project = cwd.as_deref().and_then(|c| c.rsplit('/').next()).map(ToString::to_string);

    ParsedSession {
        metadata: ParsedSessionMetadata {
            session_id: session_id.to_string(),
            project,
            agent: "codex".to_string(),
            first_message: first_user_message,
            started_at,
            ended_at,
            message_count: messages.len() as i64,
            user_message_count,
        },
        messages,
        tool_calls,
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
        conn.execute("DELETE FROM session_items WHERE session_id = ?1", [&metadata.session_id])?;
        conn.execute("DELETE FROM session_turns WHERE session_id = ?1", [&metadata.session_id])?;
        conn.execute("DELETE FROM tool_calls WHERE session_id = ?1", [&metadata.session_id])?;
        conn.execute("DELETE FROM messages WHERE session_id = ?1", [&metadata.session_id])?;
        conn.execute("DELETE FROM browsing_sessions WHERE id = ?1", [&metadata.session_id])?;

        let last_item_at = metadata.ended_at.clone().or_else(|| metadata.started_at.clone());
        let live_status = derive_live_status(last_item_at.as_deref());

        conn.execute(
            "INSERT INTO browsing_sessions (
                id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
                live_status, last_item_at, integration_mode, fidelity, capabilities_json,
                file_path, file_size, file_hash
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'codex-jsonl', 'summary', ?11, ?12, ?13, ?14
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
                live_status,
                last_item_at,
                SUMMARY_CAPABILITIES_JSON,
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

        // Insert live projection (turns + items)
        insert_live_projection(conn, parsed)?;

        // Insert tool calls
        for tool_call in &parsed.tool_calls {
            let Some(message_id) = message_ids.get(tool_call.message_ordinal).copied() else {
                continue;
            };
            conn.execute(
                "INSERT INTO tool_calls (
                    message_id, session_id, tool_name, category, tool_use_id, input_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message_id,
                    tool_call.session_id,
                    tool_call.tool_name,
                    tool_call.category,
                    tool_call.tool_use_id,
                    tool_call.input_json,
                ],
            )?;
        }

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

fn insert_live_projection(conn: &Connection, parsed: &ParsedSession) -> rusqlite::Result<()> {
    for message in &parsed.messages {
        let source_turn_id = format!("codex-message:{}", message.ordinal);
        let title = turn_title_for(message);
        conn.execute(
            "INSERT INTO session_turns (
                session_id, agent_type, source_turn_id, status, title, started_at, ended_at
            ) VALUES (?1, ?2, ?3, 'completed', ?4, ?5, ?6)",
            params![
                parsed.metadata.session_id,
                parsed.metadata.agent,
                source_turn_id,
                title,
                message.timestamp,
                message.timestamp,
            ],
        )?;
        let turn_id = conn.last_insert_rowid();

        for (item_ordinal, block) in message.blocks.iter().enumerate() {
            let Some(item) = normalize_live_item(&message.role, block, message.timestamp.as_deref())
            else {
                continue;
            };
            conn.execute(
                "INSERT INTO session_items (
                    session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    parsed.metadata.session_id,
                    turn_id,
                    item_ordinal as i64,
                    item.source_item_id
                        .unwrap_or_else(|| format!("{source_turn_id}:item:{item_ordinal}")),
                    item.kind,
                    item.status,
                    item.payload_json,
                    item.created_at,
                ],
            )?;
        }
    }
    Ok(())
}

struct LiveProjectionItem {
    kind: String,
    status: String,
    payload_json: String,
    created_at: Option<String>,
    source_item_id: Option<String>,
}

fn normalize_live_item(
    role: &str,
    block: &Value,
    created_at: Option<&str>,
) -> Option<LiveProjectionItem> {
    let block_type = block.get("type").and_then(Value::as_str)?;

    match block_type {
        "text" => Some(LiveProjectionItem {
            kind: if role == "user" {
                "user_message".to_string()
            } else {
                "assistant_message".to_string()
            },
            status: "success".to_string(),
            payload_json: json!({
                "text": block.get("text").and_then(Value::as_str).unwrap_or_default(),
            })
            .to_string(),
            created_at: created_at.map(ToString::to_string),
            source_item_id: None,
        }),
        "tool_use" => Some(LiveProjectionItem {
            kind: "tool_call".to_string(),
            status: "success".to_string(),
            payload_json: json!({
                "tool_name": block.get("name").and_then(Value::as_str).unwrap_or("unknown"),
                "input": block.get("input").cloned().unwrap_or(Value::Null),
            })
            .to_string(),
            created_at: created_at.map(ToString::to_string),
            source_item_id: block.get("id").and_then(Value::as_str).map(ToString::to_string),
        }),
        _ => None,
    }
}

fn turn_title_for(message: &ParsedMessage) -> String {
    let title = message.blocks.iter().find_map(|block| {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            block
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(|text| {
                    if text.chars().count() > 120 {
                        text.chars().take(120).collect()
                    } else {
                        text.to_string()
                    }
                })
        } else if block.get("type").and_then(Value::as_str) == Some("tool_use") {
            block
                .get("name")
                .and_then(Value::as_str)
                .map(|name| format!("Tool: {name}"))
        } else {
            None
        }
    });

    title.unwrap_or_else(|| format!("{} message {}", message.role, message.ordinal + 1))
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

fn upsert_watched_file(conn: &Connection, file_path: &Path, file_hash: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
         VALUES (?1, ?2, datetime('now'), 'parsed', datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           file_hash = excluded.file_hash,
           file_mtime = excluded.file_mtime,
           status = 'parsed',
           last_parsed_at = datetime('now')",
        params![file_path.display().to_string(), file_hash],
    )?;
    Ok(())
}
