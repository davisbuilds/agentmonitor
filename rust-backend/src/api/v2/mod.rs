use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};

use crate::state::AppState;

pub mod history;
pub mod insights;
pub mod live;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/live/settings", get(live::live_settings_handler))
        .route("/live/stream", get(live::live_stream_handler))
        .route("/live/sessions", get(live::live_sessions_handler))
        .route(
            "/live/sessions/{id}",
            get(live::live_session_detail_handler),
        )
        .route(
            "/live/sessions/{id}/turns",
            get(live::live_session_turns_handler),
        )
        .route(
            "/live/sessions/{id}/items",
            get(live::live_session_items_handler),
        )
        .route("/sessions", get(history::list_sessions_handler))
        .route("/sessions/{id}", get(history::session_detail_handler))
        .route(
            "/sessions/{id}/messages",
            get(history::session_messages_handler),
        )
        .route(
            "/sessions/{id}/activity",
            get(history::session_activity_handler),
        )
        .route("/sessions/{id}/pins", get(history::session_pins_handler))
        .route(
            "/sessions/{id}/messages/{message_id}/pin",
            post(history::pin_message_handler).delete(history::unpin_message_handler),
        )
        .route(
            "/sessions/{id}/children",
            get(history::session_children_handler),
        )
        .route("/pins", get(history::list_pins_handler))
        .route("/search", get(history::search_handler))
        .route(
            "/analytics/summary",
            get(history::analytics_summary_handler),
        )
        .route(
            "/analytics/activity",
            get(history::analytics_activity_handler),
        )
        .route(
            "/analytics/projects",
            get(history::analytics_projects_handler),
        )
        .route("/analytics/tools", get(history::analytics_tools_handler))
        .route(
            "/analytics/hour-of-week",
            get(history::analytics_hour_of_week_handler),
        )
        .route(
            "/analytics/top-sessions",
            get(history::analytics_top_sessions_handler),
        )
        .route(
            "/analytics/velocity",
            get(history::analytics_velocity_handler),
        )
        .route("/analytics/agents", get(history::analytics_agents_handler))
        .route("/usage/summary", get(history::usage_summary_handler))
        .route("/usage/daily", get(history::usage_daily_handler))
        .route("/usage/projects", get(history::usage_projects_handler))
        .route("/usage/models", get(history::usage_models_handler))
        .route("/usage/agents", get(history::usage_agents_handler))
        .route(
            "/usage/top-sessions",
            get(history::usage_top_sessions_handler),
        )
        .route("/insights", get(insights::list_insights_handler))
        .route(
            "/insights/generate",
            post(insights::generate_insight_handler),
        )
        .route(
            "/insights/{id}",
            get(insights::get_insight_handler).delete(insights::delete_insight_handler),
        )
        .route("/projects", get(history::projects_handler))
        .route("/agents", get(history::agents_handler))
}
