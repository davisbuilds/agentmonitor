use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::db::queries::{self, InsertEventParams};
use crate::pricing::{TokenCounts, calculate_cost};
use crate::util::truncate::truncate_metadata;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportSource {
    ClaudeCode,
    Codex,
    All,
}

impl ImportSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::All => "all",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub source: ImportSource,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub dry_run: bool,
    pub force: bool,
    pub claude_dir: Option<PathBuf>,
    pub codex_dir: Option<PathBuf>,
    pub max_payload_kb: usize,
}

#[derive(Debug, Serialize)]
pub struct ImportFileResult {
    pub path: String,
    pub source: String,
    pub events_found: usize,
    pub events_imported: usize,
    pub skipped_duplicate: usize,
    pub skipped_unchanged: bool,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub files: Vec<ImportFileResult>,
    pub total_files: usize,
    pub total_events_found: usize,
    pub total_events_imported: usize,
    pub total_duplicates: usize,
    pub skipped_files: usize,
}

#[derive(Debug)]
struct ImportedEvent {
    event_id: Option<String>,
    session_id: String,
    agent_type: String,
    event_type: String,
    tool_name: Option<String>,
    status: String,
    tokens_in: i64,
    tokens_out: i64,
    branch: Option<String>,
    project: Option<String>,
    duration_ms: Option<i64>,
    client_timestamp: Option<String>,
    metadata: Value,
    model: Option<String>,
    cost_usd: Option<f64>,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    source: String,
}

pub fn run_import(conn: &Connection, options: &ImportOptions) -> ImportResult {
    let mut files: Vec<ImportFileResult> = Vec::new();

    if options.source == ImportSource::ClaudeCode || options.source == ImportSource::All {
        for path in discover_claude_code_logs(options.claude_dir.as_deref()) {
            files.push(process_file(
                conn,
                &path,
                "claude-code",
                options,
                parse_claude_code_file,
            ));
        }
    }

    if options.source == ImportSource::Codex || options.source == ImportSource::All {
        for path in discover_codex_logs(options.codex_dir.as_deref()) {
            files.push(process_file(
                conn,
                &path,
                "codex",
                options,
                parse_codex_file,
            ));
        }
    }

    let mut total_events_found = 0usize;
    let mut total_events_imported = 0usize;
    let mut total_duplicates = 0usize;
    let mut skipped_files = 0usize;

    for file in &files {
        total_events_found += file.events_found;
        total_events_imported += file.events_imported;
        total_duplicates += file.skipped_duplicate;
        if file.skipped_unchanged {
            skipped_files += 1;
        }
    }

    ImportResult {
        total_files: files.len(),
        files,
        total_events_found,
        total_events_imported,
        total_duplicates,
        skipped_files,
    }
}

fn process_file(
    conn: &Connection,
    file_path: &Path,
    source: &str,
    options: &ImportOptions,
    parse_fn: fn(&Path, &ImportOptions) -> Vec<ImportedEvent>,
) -> ImportFileResult {
    if !options.force
        && let Some(existing_hash) = get_import_state_hash(conn, file_path)
        && let Ok(current_hash) = hash_file(file_path)
        && current_hash == existing_hash
    {
        return ImportFileResult {
            path: file_path.display().to_string(),
            source: source.to_string(),
            events_found: 0,
            events_imported: 0,
            skipped_duplicate: 0,
            skipped_unchanged: true,
        };
    }

    let events = parse_fn(file_path, options);
    let (events_imported, duplicates) =
        import_events(conn, &events, options.max_payload_kb, options.dry_run);

    let is_date_scoped = options.from.is_some() || options.to.is_some();
    if !options.dry_run
        && !is_date_scoped
        && !events.is_empty()
        && let Ok(hash) = hash_file(file_path)
    {
        let file_size = fs::metadata(file_path).map(|m| m.len() as i64).unwrap_or(0);
        set_import_state(
            conn,
            file_path,
            &hash,
            file_size,
            source,
            events_imported as i64,
        );
    }

    ImportFileResult {
        path: file_path.display().to_string(),
        source: source.to_string(),
        events_found: events.len(),
        events_imported,
        skipped_duplicate: duplicates,
        skipped_unchanged: false,
    }
}

fn import_events(
    conn: &Connection,
    events: &[ImportedEvent],
    max_payload_kb: usize,
    dry_run: bool,
) -> (usize, usize) {
    if dry_run {
        return (events.len(), 0);
    }

    let mut imported = 0usize;
    let mut duplicates = 0usize;

    for event in events {
        let truncated = truncate_metadata(&event.metadata, max_payload_kb);
        let params = InsertEventParams {
            event_id: event.event_id.as_deref(),
            session_id: &event.session_id,
            agent_type: &event.agent_type,
            event_type: &event.event_type,
            tool_name: event.tool_name.as_deref(),
            status: &event.status,
            tokens_in: event.tokens_in,
            tokens_out: event.tokens_out,
            branch: event.branch.as_deref(),
            project: event.project.as_deref(),
            duration_ms: event.duration_ms,
            client_timestamp: event.client_timestamp.as_deref(),
            metadata: &truncated.value,
            payload_truncated: truncated.truncated,
            model: event.model.as_deref(),
            cost_usd: event.cost_usd,
            cache_read_tokens: event.cache_read_tokens,
            cache_write_tokens: event.cache_write_tokens,
            source: &event.source,
        };

        match queries::insert_event(conn, &params) {
            Ok(Some(_)) => imported += 1,
            Ok(None) => duplicates += 1,
            Err(_) => {}
        }
    }

    (imported, duplicates)
}

fn get_import_state_hash(conn: &Connection, file_path: &Path) -> Option<String> {
    conn.query_row(
        "SELECT file_hash FROM import_state WHERE file_path = ?1",
        params![file_path.display().to_string()],
        |row| row.get(0),
    )
    .ok()
}

fn set_import_state(
    conn: &Connection,
    file_path: &Path,
    file_hash: &str,
    file_size: i64,
    source: &str,
    events_imported: i64,
) {
    let _ = conn.execute(
        "INSERT INTO import_state (file_path, file_hash, file_size, source, events_imported, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           file_hash = excluded.file_hash,
           file_size = excluded.file_size,
           events_imported = excluded.events_imported,
           imported_at = datetime('now')",
        params![
            file_path.display().to_string(),
            file_hash,
            file_size,
            source,
            events_imported
        ],
    );
}

pub fn discover_claude_code_logs(base_dir: Option<&Path>) -> Vec<PathBuf> {
    let claude_root = base_dir
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))
        .unwrap_or_else(|| PathBuf::from("."));
    let projects_dir = claude_root.join("projects");
    let mut files = Vec::new();
    if !projects_dir.exists() {
        return files;
    }
    let Ok(project_entries) = fs::read_dir(projects_dir) else {
        return files;
    };
    for project in project_entries.flatten() {
        if !project.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(entries) = fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false)
                && path.extension().and_then(|s| s.to_str()) == Some("jsonl")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

pub fn discover_codex_logs(base_dir: Option<&Path>) -> Vec<PathBuf> {
    let codex_home = base_dir
        .map(PathBuf::from)
        .or_else(|| env::var("CODEX_HOME").ok().map(PathBuf::from))
        .or_else(|| home_dir().map(|h| h.join(".codex")))
        .unwrap_or_else(|| PathBuf::from("."));
    let sessions_dir = codex_home.join("sessions");
    let mut files = Vec::new();
    walk_jsonl_files(&sessions_dir, &mut files);
    files.sort();
    files
}

fn walk_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            walk_jsonl_files(&path, out);
            continue;
        }
        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false)
            && path.extension().and_then(|s| s.to_str()) == Some("jsonl")
        {
            out.push(path);
        }
    }
}

fn parse_claude_code_file(file_path: &Path, options: &ImportOptions) -> Vec<ImportedEvent> {
    let mut events: Vec<ImportedEvent> = Vec::new();
    let Ok(content) = fs::read_to_string(file_path) else {
        return events;
    };

    let file_basename = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut prev_cost_usd = 0.0_f64;

    for (i, raw_line) in content.lines().enumerate() {
        let Ok(line) = serde_json::from_str::<Value>(raw_line) else {
            continue;
        };
        let Some(line_type) = get_string(&line, "type") else {
            continue;
        };

        let session_id = get_string(&line, "sessionId").unwrap_or_else(|| file_basename.clone());

        let timestamp = get_string(&line, "timestamp");
        if let Some(ts) = timestamp.as_deref().and_then(parse_timestamp_utc) {
            if let Some(from) = options.from.as_ref()
                && ts < *from
            {
                continue;
            }
            if let Some(to) = options.to.as_ref()
                && ts > *to
            {
                continue;
            }
        }

        let event_type = match line_type.as_str() {
            "tool_use" => "tool_use",
            "tool_result" => "tool_use",
            "assistant" => "llm_response",
            "error" => "error",
            "session_start" => "session_start",
            "session_end" => "session_end",
            _ => "response",
        }
        .to_string();

        let tool_name = get_string(&line, "name").or_else(|| get_string(&line, "tool_name"));
        let message = line.get("message");
        let model = get_string(&line, "model").or_else(|| {
            message
                .and_then(|m| m.get("model"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
        });

        let usage = line
            .get("usage")
            .or_else(|| message.and_then(|m| m.get("usage")));
        let tokens_in = usage
            .and_then(|u| u.get("input_tokens"))
            .and_then(as_i64)
            .unwrap_or(0);
        let tokens_out = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(as_i64)
            .unwrap_or(0);
        let cache_read_tokens = usage
            .and_then(|u| u.get("cache_read_input_tokens"))
            .and_then(as_i64)
            .unwrap_or(0);
        let cache_write_tokens = usage
            .and_then(|u| u.get("cache_creation_input_tokens"))
            .and_then(as_i64)
            .unwrap_or(0);

        let mut cost_delta: Option<f64> = None;
        if let Some(current_cost) = line.get("costUSD").and_then(as_f64)
            && current_cost > 0.0
        {
            let mut delta = current_cost - prev_cost_usd;
            if delta < 0.0 {
                delta = 0.0;
            }
            prev_cost_usd = current_cost;
            if delta > 0.0 {
                cost_delta = Some(delta);
            }
        }

        let project = get_string(&line, "cwd").as_deref().and_then(path_basename);
        let branch = get_string(&line, "gitBranch");

        let status = if line_type == "error"
            || line.get("is_error").and_then(|v| v.as_bool()) == Some(true)
            || get_string(&line, "status").as_deref() == Some("error")
        {
            "error".to_string()
        } else {
            "success".to_string()
        };

        let mut metadata = Map::new();
        if let Some(err) = line.get("error") {
            if let Some(err_str) = err.as_str() {
                metadata.insert("error".into(), Value::String(err_str.to_string()));
            } else if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
                metadata.insert("error".into(), Value::String(msg.to_string()));
            }
        }

        if let Some(content_value) = line.get("content") {
            if let Some(content_str) = content_value.as_str() {
                metadata.insert(
                    "content_preview".into(),
                    Value::String(slice_chars(content_str, 500)),
                );
            } else if let Some(arr) = content_value.as_array() {
                let mut parts = Vec::new();
                for block in arr {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        parts.push(text.to_string());
                    }
                }
                if !parts.is_empty() {
                    metadata.insert(
                        "content_preview".into(),
                        Value::String(slice_chars(&parts.join("\n"), 500)),
                    );
                }
            }
        }

        if line_type == "tool_use"
            && let Some(input) = line.get("input").and_then(|v| v.as_object())
        {
            for key in ["command", "file_path", "pattern", "query"] {
                if let Some(val) = input.get(key).and_then(|v| v.as_str()) {
                    metadata.insert(key.to_string(), Value::String(val.to_string()));
                }
            }
            if let Some(tool) = tool_name.as_deref() {
                if tool == "Edit" || tool == "MultiEdit" {
                    if let Some(old_str) = input.get("old_string").and_then(|v| v.as_str()) {
                        metadata.insert(
                            "lines_removed".into(),
                            Value::Number((old_str.lines().count() as i64).into()),
                        );
                    }
                    if let Some(new_str) = input.get("new_string").and_then(|v| v.as_str()) {
                        metadata.insert(
                            "lines_added".into(),
                            Value::Number((new_str.lines().count() as i64).into()),
                        );
                    }
                } else if tool == "Write"
                    && let Some(text) = input.get("content").and_then(|v| v.as_str())
                {
                    metadata.insert(
                        "lines_added".into(),
                        Value::Number((text.lines().count() as i64).into()),
                    );
                }
            }
        }

        if line_type == "tool_result"
            && let Some(output) = line.get("output")
        {
            let rendered = if let Some(text) = output.as_str() {
                text.to_string()
            } else {
                output.to_string()
            };
            metadata.insert(
                "content_preview".into(),
                Value::String(slice_chars(&rendered, 500)),
            );
        }

        let event_id = format!(
            "import-cc-{}",
            short_sha256_hex(&format!("claude-code:{session_id}:{i}"))
        );
        let is_tool_use = event_type == "tool_use";

        events.push(ImportedEvent {
            event_id: Some(event_id),
            session_id,
            agent_type: "claude_code".to_string(),
            event_type,
            tool_name: if is_tool_use { tool_name } else { None },
            status,
            tokens_in,
            tokens_out,
            branch,
            project,
            duration_ms: line
                .get("duration_ms")
                .and_then(as_i64)
                .or_else(|| line.get("durationMs").and_then(as_i64)),
            client_timestamp: timestamp,
            metadata: Value::Object(metadata),
            model,
            cost_usd: cost_delta,
            cache_read_tokens,
            cache_write_tokens,
            source: "import".to_string(),
        });
    }

    events
}

fn parse_codex_file(file_path: &Path, options: &ImportOptions) -> Vec<ImportedEvent> {
    let mut events: Vec<ImportedEvent> = Vec::new();
    let Ok(content) = fs::read_to_string(file_path) else {
        return events;
    };

    let default_model = read_codex_model(options.codex_dir.as_deref());
    let mut lines: Vec<Value> = Vec::new();
    for raw in content.lines() {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            lines.push(parsed);
        }
    }

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut session_ts: Option<String> = None;

    for line in &lines {
        if get_string(line, "type").as_deref() != Some("session_meta") {
            continue;
        }
        let payload = line.get("payload").unwrap_or(&Value::Null);
        session_id = get_string(payload, "id");
        cwd = get_string(payload, "cwd");
        session_ts = get_string(payload, "timestamp").or_else(|| get_string(line, "timestamp"));
        break;
    }

    if session_id.is_none() {
        session_id = Some(
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string(),
        );
    }
    let session_id = session_id.unwrap_or_else(|| "unknown".to_string());

    if let Some(ts) = session_ts.as_deref().and_then(parse_timestamp_utc) {
        if let Some(from) = options.from.as_ref()
            && ts < *from
        {
            return events;
        }
        if let Some(to) = options.to.as_ref()
            && ts > *to
        {
            return events;
        }
    }

    let project = cwd.as_deref().and_then(path_basename);
    let mut prev_tokens_in = 0_i64;
    let mut prev_tokens_out = 0_i64;
    let mut prev_cache_read = 0_i64;
    let mut event_index = 0usize;

    for line in &lines {
        let line_type = get_string(line, "type").unwrap_or_default();
        let timestamp = get_string(line, "timestamp");
        let payload = line.get("payload").unwrap_or(&Value::Null);

        if line_type == "session_meta" {
            let metadata = json!({
                "cli_version": get_string(payload, "originator"),
                "cwd": cwd,
            });
            let event_id = format!(
                "import-cdx-{}",
                short_sha256_hex(&format!("codex:{session_id}:meta"))
            );
            events.push(ImportedEvent {
                event_id: Some(event_id),
                session_id: session_id.clone(),
                agent_type: "codex".to_string(),
                event_type: "session_start".to_string(),
                tool_name: None,
                status: "success".to_string(),
                tokens_in: 0,
                tokens_out: 0,
                branch: None,
                project: project.clone(),
                duration_ms: None,
                client_timestamp: timestamp,
                metadata,
                model: default_model.clone(),
                cost_usd: None,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                source: "import".to_string(),
            });
            continue;
        }

        if line_type == "event_msg" && get_string(payload, "type").as_deref() == Some("token_count")
        {
            let usage = payload
                .get("info")
                .and_then(|v| v.get("total_token_usage"))
                .unwrap_or(&Value::Null);
            let total_in = usage.get("input_tokens").and_then(as_i64).unwrap_or(0);
            let total_out = usage.get("output_tokens").and_then(as_i64).unwrap_or(0);
            let total_cache = usage
                .get("cached_input_tokens")
                .and_then(as_i64)
                .unwrap_or(0);

            let delta_in = total_in - prev_tokens_in;
            let delta_out = total_out - prev_tokens_out;
            let delta_cache_read = total_cache - prev_cache_read;

            prev_tokens_in = total_in;
            prev_tokens_out = total_out;
            prev_cache_read = total_cache;

            if delta_in <= 0 && delta_out <= 0 {
                continue;
            }

            let cost_usd = default_model.as_deref().and_then(|model| {
                calculate_cost(
                    model,
                    TokenCounts {
                        input: delta_in,
                        output: delta_out,
                        cache_read: delta_cache_read,
                        cache_write: 0,
                    },
                )
            });

            let event_id = format!(
                "import-cdx-{}",
                short_sha256_hex(&format!("codex:{session_id}:token:{event_index}"))
            );
            let metadata = json!({
                "_synthetic": true,
                "_source": "codex_session_jsonl",
            });

            events.push(ImportedEvent {
                event_id: Some(event_id),
                session_id: session_id.clone(),
                agent_type: "codex".to_string(),
                event_type: "llm_response".to_string(),
                tool_name: None,
                status: "success".to_string(),
                tokens_in: delta_in,
                tokens_out: delta_out,
                branch: None,
                project: project.clone(),
                duration_ms: None,
                client_timestamp: timestamp,
                metadata,
                model: default_model.clone(),
                cost_usd,
                cache_read_tokens: delta_cache_read,
                cache_write_tokens: 0,
                source: "import".to_string(),
            });
            event_index += 1;
            continue;
        }

        if line_type == "response_item" {
            let patch_content = extract_patch_content(payload);
            if let Some(patch) = patch_content
                && let Some(meta) = parse_patch_meta(&patch)
            {
                let event_id = format!(
                    "import-cdx-{}",
                    short_sha256_hex(&format!("codex:{session_id}:patch:{event_index}"))
                );
                let metadata = json!({
                    "file_path": meta.file_path,
                    "lines_added": meta.lines_added,
                    "lines_removed": meta.lines_removed,
                });
                events.push(ImportedEvent {
                    event_id: Some(event_id),
                    session_id: session_id.clone(),
                    agent_type: "codex".to_string(),
                    event_type: "tool_use".to_string(),
                    tool_name: Some("apply_patch".to_string()),
                    status: "success".to_string(),
                    tokens_in: 0,
                    tokens_out: 0,
                    branch: None,
                    project: project.clone(),
                    duration_ms: None,
                    client_timestamp: timestamp,
                    metadata,
                    model: None,
                    cost_usd: None,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    source: "import".to_string(),
                });
                event_index += 1;
            }
        }
    }

    if !events.is_empty() {
        let last_ts = lines.last().and_then(|v| get_string(v, "timestamp"));
        let event_id = format!(
            "import-cdx-{}",
            short_sha256_hex(&format!("codex:{session_id}:end"))
        );
        let metadata = json!({
            "total_tokens_in": prev_tokens_in,
            "total_tokens_out": prev_tokens_out,
            "total_cache_read": prev_cache_read,
        });
        events.push(ImportedEvent {
            event_id: Some(event_id),
            session_id,
            agent_type: "codex".to_string(),
            event_type: "session_end".to_string(),
            tool_name: None,
            status: "success".to_string(),
            tokens_in: 0,
            tokens_out: 0,
            branch: None,
            project,
            duration_ms: None,
            client_timestamp: last_ts,
            metadata,
            model: default_model,
            cost_usd: None,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            source: "import".to_string(),
        });
    }

    events
}

fn extract_patch_content(payload: &Value) -> Option<String> {
    if get_string(payload, "name").as_deref() == Some("apply_patch")
        && let Some(input) = get_string(payload, "input")
    {
        return Some(input);
    }

    if get_string(payload, "name").as_deref() == Some("exec_command")
        && let Some(arguments) = get_string(payload, "arguments")
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(&arguments)
            && let Some(cmd) = get_string(&parsed, "cmd")
            && cmd.starts_with("apply_patch")
        {
            return Some(cmd);
        }
        if arguments.starts_with("apply_patch") || arguments.contains("*** Begin Patch") {
            return Some(arguments);
        }
    }

    None
}

struct PatchMeta {
    file_path: String,
    lines_added: i64,
    lines_removed: i64,
}

fn parse_patch_meta(patch: &str) -> Option<PatchMeta> {
    let mut file_path: Option<String> = None;
    let mut lines_added = 0_i64;
    let mut lines_removed = 0_i64;

    for line in patch.lines() {
        if let Some(path) = line
            .strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Add File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
        {
            file_path = Some(path.trim().to_string());
            continue;
        }

        if line.starts_with('+') && !line.starts_with("+++") && !line.starts_with("***") {
            lines_added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") && !line.starts_with("***") {
            lines_removed += 1;
        }
    }

    file_path.map(|path| PatchMeta {
        file_path: path,
        lines_added,
        lines_removed,
    })
}

fn read_codex_model(base_dir: Option<&Path>) -> Option<String> {
    let base = base_dir
        .map(PathBuf::from)
        .or_else(|| env::var("CODEX_HOME").ok().map(PathBuf::from))
        .or_else(|| home_dir().map(|h| h.join(".codex")))?;
    let config_path = base.join("config.toml");
    let content = fs::read_to_string(config_path).ok()?;
    for raw in content.lines() {
        let line = raw.trim();
        if !line.starts_with("model") {
            continue;
        }
        let mut parts = line.splitn(2, '=');
        let _ = parts.next();
        let value = parts.next()?.trim();
        if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
            return Some(value[1..value.len() - 1].to_string());
        }
    }
    None
}

fn parse_timestamp_utc(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

fn hash_file(path: &Path) -> Result<String, std::io::Error> {
    let bytes = fs::read(path)?;
    Ok(sha256_hex(&bytes))
}

fn short_sha256_hex(input: &str) -> String {
    let digest = sha256_hex(input.as_bytes());
    digest.chars().take(32).collect()
}

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    format!("{:x}", hasher.finalize())
}

fn get_string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(ToString::to_string)
}

fn as_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn as_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_i64().map(|i| i as f64))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn path_basename(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(ToString::to_string)
}

fn slice_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
