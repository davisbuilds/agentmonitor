use std::sync::{Arc, Mutex, OnceLock};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{InsightProviderConfig, InsightsProvider};
use crate::db::v2_queries::{
    AnalyticsParams, CreateInsightInput, InsightRow, create_insight, get_analytics_activity,
    get_analytics_agents, get_analytics_coverage, get_analytics_hour_of_week,
    get_analytics_projects, get_analytics_summary, get_analytics_tools, get_analytics_top_sessions,
    get_analytics_velocity, get_usage_agents, get_usage_coverage, get_usage_daily,
    get_usage_models, get_usage_projects, get_usage_summary, get_usage_top_sessions,
};
use crate::state::AppState;

const MAX_ACTIVITY_POINTS: usize = 31;
const MAX_BREAKDOWN_ROWS: usize = 8;
const MAX_TOP_SESSIONS: i64 = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InsightKind {
    Overview,
    Workflow,
    Usage,
}

impl InsightKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Workflow => "workflow",
            Self::Usage => "usage",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerateInsightParams {
    pub kind: InsightKind,
    pub date_from: String,
    pub date_to: String,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub prompt: Option<String>,
    pub provider: Option<InsightsProvider>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct InsightDatasetPacket {
    analytics_summary: Value,
    analytics_coverage: Value,
    usage_summary: Value,
    usage_coverage: Value,
    input_snapshot: Value,
}

#[derive(Debug, Clone)]
struct GeneratedInsightContent {
    title: String,
    content: String,
    provider: InsightsProvider,
    model: String,
}

#[derive(Debug, Clone)]
pub struct TestGeneratedInsight {
    pub title: String,
    pub content: String,
    pub provider: InsightsProvider,
    pub model: String,
}

type OverrideGenerator = fn(&GenerateInsightParams) -> Result<TestGeneratedInsight, String>;

static GENERATOR_OVERRIDE: OnceLock<Mutex<Option<OverrideGenerator>>> = OnceLock::new();

pub fn set_insight_generator_for_tests(generator: Option<OverrideGenerator>) {
    let slot = GENERATOR_OVERRIDE.get_or_init(|| Mutex::new(None));
    *slot.lock().expect("generator override mutex") = generator;
}

pub fn generation_metadata(state: &AppState) -> Value {
    json!({
        "default_provider": state.config.insights.provider.as_str(),
        "providers": {
            "openai": {
                "configured": state.config.insights.providers.openai.api_key.is_some(),
                "default_model": state.config.insights.providers.openai.model,
            },
            "anthropic": {
                "configured": state.config.insights.providers.anthropic.api_key.is_some(),
                "default_model": state.config.insights.providers.anthropic.model,
            },
            "gemini": {
                "configured": state.config.insights.providers.gemini.api_key.is_some(),
                "default_model": state.config.insights.providers.gemini.model,
            },
        }
    })
}

fn kind_label(kind: &InsightKind) -> &'static str {
    match kind {
        InsightKind::Workflow => "Workflow Review",
        InsightKind::Usage => "Usage Review",
        InsightKind::Overview => "Overview",
    }
}

fn normalize_analytics_agent(agent: Option<&str>) -> Option<String> {
    match agent {
        Some("claude_code") => Some("claude".to_string()),
        Some(value) => Some(value.to_string()),
        None => None,
    }
}

fn normalize_usage_agent(agent: Option<&str>) -> Option<String> {
    match agent {
        Some("claude") => Some("claude_code".to_string()),
        Some(value) => Some(value.to_string()),
        None => None,
    }
}

fn to_json_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| err.to_string())
}

fn build_insight_dataset(
    conn: &rusqlite::Connection,
    params: &GenerateInsightParams,
) -> Result<InsightDatasetPacket, String> {
    let analytics_params = AnalyticsParams {
        date_from: Some(params.date_from.clone()),
        date_to: Some(params.date_to.clone()),
        project: params.project.clone(),
        agent: normalize_analytics_agent(params.agent.as_deref()),
        limit: None,
    };
    let usage_params = AnalyticsParams {
        date_from: Some(params.date_from.clone()),
        date_to: Some(params.date_to.clone()),
        project: params.project.clone(),
        agent: normalize_usage_agent(params.agent.as_deref()),
        limit: None,
    };

    let analytics_summary =
        to_json_value(get_analytics_summary(conn, &analytics_params).map_err(|e| e.to_string())?)?;
    let analytics_coverage = to_json_value(
        get_analytics_coverage(conn, &analytics_params, "all_sessions")
            .map_err(|e| e.to_string())?,
    )?;
    let usage_summary =
        to_json_value(get_usage_summary(conn, &usage_params).map_err(|e| e.to_string())?)?;
    let usage_coverage =
        to_json_value(get_usage_coverage(conn, &usage_params).map_err(|e| e.to_string())?)?;

    let input_snapshot = json!({
        "analytics_activity": get_analytics_activity(conn, &analytics_params).map_err(|e| e.to_string())?
            .into_iter()
            .rev()
            .take(MAX_ACTIVITY_POINTS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>(),
        "analytics_projects": get_analytics_projects(conn, &analytics_params).map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_BREAKDOWN_ROWS)
            .collect::<Vec<_>>(),
        "analytics_tools": get_analytics_tools(conn, &analytics_params).map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_BREAKDOWN_ROWS)
            .collect::<Vec<_>>(),
        "analytics_hour_of_week": get_analytics_hour_of_week(conn, &analytics_params).map_err(|e| e.to_string())?,
        "analytics_top_sessions": get_analytics_top_sessions(conn, &AnalyticsParams { limit: Some(MAX_TOP_SESSIONS), ..analytics_params.clone() })
            .map_err(|e| e.to_string())?,
        "analytics_velocity": get_analytics_velocity(conn, &analytics_params).map_err(|e| e.to_string())?,
        "analytics_agents": get_analytics_agents(conn, &analytics_params).map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_BREAKDOWN_ROWS)
            .collect::<Vec<_>>(),
        "usage_daily": get_usage_daily(conn, &usage_params).map_err(|e| e.to_string())?
            .into_iter()
            .rev()
            .take(MAX_ACTIVITY_POINTS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>(),
        "usage_projects": get_usage_projects(conn, &usage_params).map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_BREAKDOWN_ROWS)
            .collect::<Vec<_>>(),
        "usage_models": get_usage_models(conn, &usage_params).map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_BREAKDOWN_ROWS)
            .collect::<Vec<_>>(),
        "usage_agents": get_usage_agents(conn, &usage_params).map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_BREAKDOWN_ROWS)
            .collect::<Vec<_>>(),
        "usage_top_sessions": get_usage_top_sessions(conn, &AnalyticsParams { limit: Some(MAX_TOP_SESSIONS), ..usage_params.clone() })
            .map_err(|e| e.to_string())?,
    });

    Ok(InsightDatasetPacket {
        analytics_summary,
        analytics_coverage,
        usage_summary,
        usage_coverage,
        input_snapshot,
    })
}

fn build_system_instructions(kind: &InsightKind) -> &'static str {
    match kind {
        InsightKind::Workflow => {
            "You are generating an operational workflow review for AgentMonitor. Focus on process bottlenecks, agent/tool usage patterns, and concrete workflow improvements. Stay grounded in the provided data. If coverage is partial, say so explicitly."
        }
        InsightKind::Usage => {
            "You are generating a usage and cost review for AgentMonitor. Focus on spend concentration, token patterns, model mix, and pragmatic efficiency recommendations. Stay grounded in the provided data. If coverage is partial, say so explicitly."
        }
        InsightKind::Overview => {
            "You are generating a concise operational summary for AgentMonitor. Focus on delivery patterns, throughput, project concentration, and notable trends. Stay grounded in the provided data. If coverage is partial, say so explicitly."
        }
    }
}

fn build_prompt(params: &GenerateInsightParams, packet: &InsightDatasetPacket) -> String {
    let mut lines = vec![
        "## Scope".to_string(),
        format!("- Kind: {}", kind_label(&params.kind)),
        format!("- Date range: {} to {}", params.date_from, params.date_to),
        format!(
            "- Project filter: {}",
            params.project.as_deref().unwrap_or("all projects")
        ),
        format!(
            "- Agent filter: {}",
            params.agent.as_deref().unwrap_or("all agents")
        ),
        String::new(),
        "## Output Requirements".to_string(),
        " - Return markdown.".trim_start().to_string(),
        format!(
            "- The first line must be a level-1 heading with a short title for this {}.",
            kind_label(&params.kind).to_lowercase()
        ),
        "- Include sections named: Scope, Findings, Recommendations.".to_string(),
        "- Keep Findings and Recommendations concrete and evidence-based.".to_string(),
        "- Mention data-coverage limits directly in Scope.".to_string(),
        "- Do not fabricate missing sessions, tools, models, or costs.".to_string(),
    ];
    if let Some(prompt) = params
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        lines.push(format!("- Additional user steering: {prompt}"));
    }
    lines.push(String::new());
    lines.push("## Dataset".to_string());
    lines.push("```json".to_string());
    lines.push(serde_json::to_string_pretty(packet).unwrap_or_else(|_| "{}".to_string()));
    lines.push("```".to_string());
    lines.join("\n")
}

fn extract_output_text(payload: &Value) -> String {
    if let Some(text) = payload.get("output_text").and_then(Value::as_str)
        && !text.trim().is_empty()
    {
        return text.trim().to_string();
    }

    payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn extract_anthropic_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn extract_gemini_text(payload: &Value) -> String {
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn extract_title(content: &str, kind: &InsightKind, params: &GenerateInsightParams) -> String {
    if let Some(first_heading) = content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        && !first_heading.is_empty()
    {
        return first_heading.to_string();
    }

    let range = if params.date_from == params.date_to {
        params.date_from.clone()
    } else {
        format!("{} to {}", params.date_from, params.date_to)
    };
    format!("{} • {}", kind_label(kind), range)
}

fn normalize_gemini_model(model: &str) -> String {
    model.trim_start_matches("models/").to_string()
}

fn resolve_requested_provider(
    state: &AppState,
    params: &GenerateInsightParams,
) -> (InsightsProvider, InsightProviderConfig) {
    let provider = params
        .provider
        .clone()
        .unwrap_or_else(|| state.config.insights.provider.clone());
    let mut config = match provider {
        InsightsProvider::OpenAi => state.config.insights.providers.openai.clone(),
        InsightsProvider::Anthropic => state.config.insights.providers.anthropic.clone(),
        InsightsProvider::Gemini => state.config.insights.providers.gemini.clone(),
    };
    if let Some(model) = params
        .model
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        config.model = model.to_string();
    }
    (provider, config)
}

async fn generate_with_openai(
    client: &Client,
    state: &AppState,
    params: &GenerateInsightParams,
    packet: &InsightDatasetPacket,
) -> Result<GeneratedInsightContent, String> {
    let (provider, config) = resolve_requested_provider(state, params);
    let Some(api_key) = config.api_key.clone() else {
        return Err(
            "Insight generation requires AGENTMONITOR_OPENAI_API_KEY or OPENAI_API_KEY."
                .to_string(),
        );
    };
    let prompt = build_prompt(params, packet);
    let payload = client
        .post(format!("{}/responses", config.base_url))
        .bearer_auth(api_key)
        .json(&json!({
            "model": config.model,
            "input": [
                { "role": "developer", "content": build_system_instructions(&params.kind) },
                { "role": "user", "content": prompt },
            ],
            "max_output_tokens": 1800
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !payload.status().is_success() {
        let status = payload.status();
        let body = payload.text().await.unwrap_or_default();
        return Err(format!("Insight generation failed ({status}): {body}"));
    }
    let json = payload
        .json::<Value>()
        .await
        .map_err(|err| err.to_string())?;
    let content = extract_output_text(&json);
    if content.is_empty() {
        return Err("Insight generation returned no text output.".to_string());
    }
    Ok(GeneratedInsightContent {
        title: extract_title(&content, &params.kind, params),
        content,
        provider,
        model: config.model,
    })
}

async fn generate_with_anthropic(
    client: &Client,
    state: &AppState,
    params: &GenerateInsightParams,
    packet: &InsightDatasetPacket,
) -> Result<GeneratedInsightContent, String> {
    let (provider, config) = resolve_requested_provider(state, params);
    let Some(api_key) = config.api_key.clone() else {
        return Err(
            "Insight generation requires AGENTMONITOR_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY."
                .to_string(),
        );
    };
    let prompt = build_prompt(params, packet);
    let payload = client
        .post(format!("{}/messages", config.base_url))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": config.model,
            "max_tokens": 1800,
            "system": build_system_instructions(&params.kind),
            "messages": [{ "role": "user", "content": prompt }],
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !payload.status().is_success() {
        let status = payload.status();
        let body = payload.text().await.unwrap_or_default();
        return Err(format!("Insight generation failed ({status}): {body}"));
    }
    let json = payload
        .json::<Value>()
        .await
        .map_err(|err| err.to_string())?;
    let content = extract_anthropic_text(&json);
    if content.is_empty() {
        return Err("Insight generation returned no text output.".to_string());
    }
    Ok(GeneratedInsightContent {
        title: extract_title(&content, &params.kind, params),
        content,
        provider,
        model: config.model,
    })
}

async fn generate_with_gemini(
    client: &Client,
    state: &AppState,
    params: &GenerateInsightParams,
    packet: &InsightDatasetPacket,
) -> Result<GeneratedInsightContent, String> {
    let (provider, mut config) = resolve_requested_provider(state, params);
    let Some(api_key) = config.api_key.clone() else {
        return Err(
            "Insight generation requires AGENTMONITOR_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY."
                .to_string(),
        );
    };
    config.model = normalize_gemini_model(&config.model);
    let prompt = build_prompt(params, packet);
    let payload = client
        .post(format!(
            "{}/models/{}:generateContent",
            config.base_url, config.model
        ))
        .header("x-goog-api-key", api_key)
        .header("x-goog-api-client", "agentmonitor-insights/1.0")
        .json(&json!({
            "systemInstruction": {
                "parts": [{ "text": build_system_instructions(&params.kind) }],
            },
            "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
            "generationConfig": { "maxOutputTokens": 1800 }
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !payload.status().is_success() {
        let status = payload.status();
        let body = payload.text().await.unwrap_or_default();
        return Err(format!("Insight generation failed ({status}): {body}"));
    }
    let json = payload
        .json::<Value>()
        .await
        .map_err(|err| err.to_string())?;
    let content = extract_gemini_text(&json);
    if content.is_empty() {
        return Err("Insight generation returned no text output.".to_string());
    }
    Ok(GeneratedInsightContent {
        title: extract_title(&content, &params.kind, params),
        content,
        provider,
        model: config.model,
    })
}

async fn generate_with_provider(
    state: &AppState,
    params: &GenerateInsightParams,
    packet: &InsightDatasetPacket,
) -> Result<GeneratedInsightContent, String> {
    let client = Client::new();
    match params
        .provider
        .clone()
        .unwrap_or_else(|| state.config.insights.provider.clone())
    {
        InsightsProvider::Anthropic => {
            generate_with_anthropic(&client, state, params, packet).await
        }
        InsightsProvider::Gemini => generate_with_gemini(&client, state, params, packet).await,
        InsightsProvider::OpenAi => generate_with_openai(&client, state, params, packet).await,
    }
}

pub async fn generate_insight(
    state: Arc<AppState>,
    params: GenerateInsightParams,
) -> Result<InsightRow, String> {
    if params.date_from.is_empty() || params.date_to.is_empty() {
        return Err("date_from and date_to are required.".to_string());
    }
    if params.date_from > params.date_to {
        return Err("date_from must be on or before date_to.".to_string());
    }

    let dataset = {
        let db = state.db.lock().await;
        build_insight_dataset(&db, &params)?
    };

    let generated = if let Some(generator) = GENERATOR_OVERRIDE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("generator override mutex")
        .as_ref()
        .copied()
    {
        let generated = generator(&params)?;
        GeneratedInsightContent {
            title: generated.title,
            content: generated.content,
            provider: generated.provider,
            model: generated.model,
        }
    } else {
        generate_with_provider(&state, &params, &dataset).await?
    };

    let db = state.db.lock().await;
    create_insight(
        &db,
        &CreateInsightInput {
            kind: params.kind.as_str().to_string(),
            title: generated.title,
            prompt: params
                .prompt
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            content: generated.content,
            date_from: params.date_from,
            date_to: params.date_to,
            project: params.project,
            agent: params.agent,
            provider: generated.provider.as_str().to_string(),
            model: generated.model,
            analytics_summary: dataset.analytics_summary,
            analytics_coverage: dataset.analytics_coverage,
            usage_summary: dataset.usage_summary,
            usage_coverage: dataset.usage_coverage,
            input_snapshot: dataset.input_snapshot,
        },
    )
    .map_err(|err| err.to_string())
}
