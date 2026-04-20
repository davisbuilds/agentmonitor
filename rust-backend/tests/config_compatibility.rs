use std::collections::HashMap;

use agentmonitor_rs::config::{Config, InsightsProvider};

#[test]
fn sync_and_insights_defaults_match_typescript() {
    let config = Config::from_env_map(&HashMap::new());

    assert!(config.sync.exclude_patterns.is_empty());
    assert_eq!(config.insights.provider, InsightsProvider::OpenAi);
    assert_eq!(config.insights.providers.openai.model, "gpt-5-mini");
    assert_eq!(
        config.insights.providers.openai.base_url,
        "https://api.openai.com/v1"
    );
    assert_eq!(
        config.insights.providers.anthropic.model,
        "claude-sonnet-4-5"
    );
    assert_eq!(
        config.insights.providers.anthropic.base_url,
        "https://api.anthropic.com/v1"
    );
    assert_eq!(config.insights.providers.gemini.model, "gemini-2.5-flash");
    assert_eq!(
        config.insights.providers.gemini.base_url,
        "https://generativelanguage.googleapis.com/v1beta"
    );
    assert_eq!(config.insights.active_provider().model, "gpt-5-mini");
}

#[test]
fn sync_exclude_patterns_are_trimmed_and_deduped() {
    let env = HashMap::from([(
        "AGENTMONITOR_SYNC_EXCLUDE_PATTERNS".to_string(),
        " node_modules , , vercel-plugin,vercel-plugin,nested/sessions ".to_string(),
    )]);

    let config = Config::from_env_map(&env);

    assert_eq!(
        config.sync.exclude_patterns,
        vec![
            "node_modules".to_string(),
            "vercel-plugin".to_string(),
            "nested/sessions".to_string()
        ]
    );
}

#[test]
fn insights_provider_settings_follow_typescript_precedence() {
    let env = HashMap::from([
        (
            "AGENTMONITOR_INSIGHTS_PROVIDER".to_string(),
            "anthropic".to_string(),
        ),
        ("OPENAI_API_KEY".to_string(), "openai-fallback".to_string()),
        (
            "AGENTMONITOR_INSIGHTS_MODEL".to_string(),
            "generic-openai-model".to_string(),
        ),
        (
            "AGENTMONITOR_OPENAI_BASE_URL".to_string(),
            "https://openai.example/v1///".to_string(),
        ),
        (
            "ANTHROPIC_API_KEY".to_string(),
            "anthropic-fallback".to_string(),
        ),
        (
            "AGENTMONITOR_ANTHROPIC_API_KEY".to_string(),
            "anthropic-primary".to_string(),
        ),
        (
            "AGENTMONITOR_ANTHROPIC_INSIGHTS_MODEL".to_string(),
            "claude-custom".to_string(),
        ),
        (
            "AGENTMONITOR_ANTHROPIC_BASE_URL".to_string(),
            "https://anthropic.example/v1/".to_string(),
        ),
        ("GOOGLE_API_KEY".to_string(), "gemini-fallback".to_string()),
        (
            "AGENTMONITOR_INSIGHTS_GEMINI_MODEL".to_string(),
            "gemini-custom".to_string(),
        ),
        (
            "AGENTMONITOR_GEMINI_BASE_URL".to_string(),
            "https://gemini.example/v1beta//".to_string(),
        ),
    ]);

    let config = Config::from_env_map(&env);

    assert_eq!(config.insights.provider, InsightsProvider::Anthropic);

    assert_eq!(
        config.insights.providers.openai.api_key.as_deref(),
        Some("openai-fallback")
    );
    assert_eq!(
        config.insights.providers.openai.model,
        "generic-openai-model"
    );
    assert_eq!(
        config.insights.providers.openai.base_url,
        "https://openai.example/v1"
    );

    assert_eq!(
        config.insights.providers.anthropic.api_key.as_deref(),
        Some("anthropic-primary")
    );
    assert_eq!(config.insights.providers.anthropic.model, "claude-custom");
    assert_eq!(
        config.insights.providers.anthropic.base_url,
        "https://anthropic.example/v1"
    );

    assert_eq!(
        config.insights.providers.gemini.api_key.as_deref(),
        Some("gemini-fallback")
    );
    assert_eq!(config.insights.providers.gemini.model, "gemini-custom");
    assert_eq!(
        config.insights.providers.gemini.base_url,
        "https://gemini.example/v1beta"
    );

    assert_eq!(config.insights.active_provider().model, "claude-custom");
}

#[test]
fn invalid_insights_provider_defaults_to_openai() {
    let env = HashMap::from([(
        "AGENTMONITOR_INSIGHTS_PROVIDER".to_string(),
        "not-a-provider".to_string(),
    )]);

    let config = Config::from_env_map(&env);

    assert_eq!(config.insights.provider, InsightsProvider::OpenAi);
}
