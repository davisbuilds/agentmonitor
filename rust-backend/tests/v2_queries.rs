use std::path::Path;

use agentmonitor_rs::db;
use agentmonitor_rs::db::v2_queries::{
    AnalyticsParams, LiveItemsListParams, LiveSessionsListParams, MessagesListParams,
    PinsListParams, SearchParams, SessionsListParams, get_analytics_activity, get_analytics_agents,
    get_analytics_coverage, get_analytics_hour_of_week, get_analytics_projects,
    get_analytics_summary, get_analytics_tools, get_analytics_top_sessions, get_analytics_velocity,
    get_browsing_session, get_distinct_agents, get_distinct_projects, get_live_session,
    get_session_activity, get_session_children, get_session_items, get_session_messages,
    get_session_turns, list_browsing_sessions, list_live_sessions, list_pinned_messages,
    pin_message, search_messages, unpin_message,
};

fn setup_db() -> rusqlite::Connection {
    db::initialize(Path::new(":memory:")).expect("in-memory db")
}

fn seed_historical_v2(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO browsing_sessions (
            id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
            parent_session_id, relationship_type, live_status, last_item_at, integration_mode, fidelity,
            capabilities_json, file_path, file_size, file_hash
        ) VALUES (
            'sess-a', 'project-alpha', 'claude', 'Needle session', '2026-04-09T10:00:00Z', '2026-04-09T10:05:00Z',
            4, 2, NULL, NULL, 'ended', '2026-04-09T10:05:00Z', 'claude-jsonl', 'full',
            '{\"history\":\"full\",\"search\":\"full\",\"tool_analytics\":\"full\",\"live_items\":\"full\"}',
            '/tmp/sess-a.jsonl', 123, 'hash-a'
        )",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO browsing_sessions (
            id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
            parent_session_id, relationship_type, live_status, last_item_at, integration_mode, fidelity,
            capabilities_json, file_path, file_size, file_hash
        ) VALUES (
            'sess-child', 'project-alpha', 'claude', 'Child session', '2026-04-09T10:02:00Z', '2026-04-09T10:03:00Z',
            1, 1, 'sess-a', 'subagent', 'ended', '2026-04-09T10:03:00Z', 'claude-jsonl', 'full',
            '{\"history\":\"full\",\"search\":\"full\",\"tool_analytics\":\"full\",\"live_items\":\"full\"}',
            '/tmp/sess-child.jsonl', 50, 'hash-child'
        )",
        [],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO messages (id, session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
         VALUES
         (1, 'sess-a', 0, 'user', '[{\"type\":\"text\",\"text\":\"Needle question\"}]', '2026-04-09T10:00:00Z', 0, 0, 36),
         (2, 'sess-a', 1, 'assistant', '[{\"type\":\"thinking\",\"text\":\"plan\"},{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Read\",\"input\":{\"file_path\":\"README.md\"}}]', '2026-04-09T10:01:00Z', 1, 1, 120),
         (3, 'sess-a', 2, 'user', '[{\"type\":\"text\",\"text\":\"Needle follow-up\"}]', '2026-04-09T10:02:00Z', 0, 0, 40),
         (4, 'sess-a', 3, 'assistant', '[{\"type\":\"text\",\"text\":\"Needle answer\"}]', '2026-04-09T10:03:00Z', 0, 0, 36)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tool_calls (
            message_id, session_id, tool_name, category, tool_use_id, input_json, result_content,
            result_content_length, subagent_session_id
        ) VALUES (
            2, 'sess-a', 'Read', 'Read', 'tool-1', '{\"file_path\":\"README.md\"}', NULL, NULL, 'sess-child'
        )",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_turns (
            id, session_id, agent_type, source_turn_id, status, title, started_at, ended_at, created_at
        ) VALUES
        (1, 'sess-a', 'claude', 'claude-message:0', 'completed', 'Needle question', '2026-04-09T10:00:00Z', '2026-04-09T10:00:00Z', '2026-04-09T10:00:00Z'),
        (2, 'sess-a', 'claude', 'claude-message:1', 'completed', 'Read file', '2026-04-09T10:01:00Z', '2026-04-09T10:01:00Z', '2026-04-09T10:01:00Z'),
        (3, 'sess-child', 'claude', 'claude-message:0', 'completed', 'Child turn', '2026-04-09T10:02:00Z', '2026-04-09T10:02:00Z', '2026-04-09T10:02:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_items (
            id, session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
        ) VALUES
        (1, 'sess-a', 1, 0, 'item-1', 'user_message', 'success', '{\"text\":\"Needle question\"}', '2026-04-09T10:00:00Z'),
        (2, 'sess-a', 2, 0, 'item-2', 'reasoning', 'success', '{\"text\":\"plan\"}', '2026-04-09T10:01:00Z'),
        (3, 'sess-a', 2, 1, 'tool-1', 'tool_call', 'success', '{\"tool_name\":\"Read\"}', '2026-04-09T10:01:00Z'),
        (4, 'sess-a', 2, 2, 'tool-1', 'tool_result', 'success', '{\"content\":\"done\"}', '2026-04-09T10:01:01Z'),
        (5, 'sess-child', 3, 0, 'item-child', 'assistant_message', 'success', '{\"text\":\"child\"}', '2026-04-09T10:02:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')",
        [],
    )
    .unwrap();
}

fn seed_relevance_history(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO browsing_sessions (
            id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
            parent_session_id, relationship_type, live_status, last_item_at, integration_mode, fidelity,
            capabilities_json, file_path, file_size, file_hash
        ) VALUES
        (
            'sess-rank-dense', 'project-alpha', 'claude', 'rankmagic dense', '2026-04-10T10:00:00Z', '2026-04-10T10:05:00Z',
            1, 1, NULL, NULL, 'ended', '2026-04-10T10:05:00Z', 'claude-jsonl', 'full',
            '{\"history\":\"full\",\"search\":\"full\",\"tool_analytics\":\"full\",\"live_items\":\"full\"}',
            '/tmp/sess-rank-dense.jsonl', 111, 'hash-rank-dense'
        ),
        (
            'sess-rank-medium', 'project-alpha', 'claude', 'rankmagic medium', '2026-04-10T10:30:00Z', '2026-04-10T10:35:00Z',
            1, 1, NULL, NULL, 'ended', '2026-04-10T10:35:00Z', 'claude-jsonl', 'full',
            '{\"history\":\"full\",\"search\":\"full\",\"tool_analytics\":\"full\",\"live_items\":\"full\"}',
            '/tmp/sess-rank-medium.jsonl', 113, 'hash-rank-medium'
        ),
        (
            'sess-rank-thin', 'project-alpha', 'claude', 'rankmagic thin', '2026-04-10T11:00:00Z', '2026-04-10T11:02:00Z',
            1, 1, NULL, NULL, 'ended', '2026-04-10T11:02:00Z', 'claude-jsonl', 'full',
            '{\"history\":\"full\",\"search\":\"full\",\"tool_analytics\":\"full\",\"live_items\":\"full\"}',
            '/tmp/sess-rank-thin.jsonl', 112, 'hash-rank-thin'
        )",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages (id, session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
         VALUES
         (10, 'sess-rank-dense', 0, 'user', 'rankmagic rankmagic rankmagic rankmagic', '2026-04-10T10:00:00Z', 0, 0, 36),
         (11, 'sess-rank-medium', 0, 'user', 'rankmagic rankmagic', '2026-04-10T10:30:00Z', 0, 0, 20),
         (12, 'sess-rank-thin', 0, 'user', 'rankmagic once', '2026-04-10T11:00:00Z', 0, 0, 14)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')",
        [],
    )
    .unwrap();
}

fn seed_analytics_variant(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO browsing_sessions (
            id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
            parent_session_id, relationship_type, live_status, last_item_at, integration_mode, fidelity,
            capabilities_json, file_path, file_size, file_hash
        ) VALUES (
            'sess-summary', 'project-alpha', 'codex', 'Summary session', '2026-04-10T12:00:00Z', '2026-04-10T12:05:00Z',
            2, 1, NULL, NULL, 'ended', '2026-04-10T12:05:00Z', 'codex-jsonl', 'summary',
            NULL,
            '/tmp/sess-summary.jsonl', 80, 'hash-summary'
        )",
        [],
    )
    .unwrap();
}

#[test]
fn sessions_queries_return_canonical_shapes() {
    let conn = setup_db();
    seed_historical_v2(&conn);

    let list = list_browsing_sessions(
        &conn,
        &SessionsListParams {
            project: Some("project-alpha".into()),
            agent: Some("claude".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(list.total, 2);
    assert_eq!(list.data[0].id, "sess-child");
    assert_eq!(list.data[1].id, "sess-a");
    assert_eq!(
        list.data[1]
            .capabilities
            .as_ref()
            .expect("capabilities")
            .history,
        "full"
    );

    let detail = get_browsing_session(&conn, "sess-a")
        .unwrap()
        .expect("session");
    assert_eq!(detail.message_count, 4);
    assert_eq!(detail.integration_mode.as_deref(), Some("claude-jsonl"));

    let children = get_session_children(&conn, "sess-a").unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].id, "sess-child");
}

#[test]
fn message_search_and_metadata_queries_work() {
    let conn = setup_db();
    seed_historical_v2(&conn);

    let messages = get_session_messages(
        &conn,
        "sess-a",
        &MessagesListParams {
            offset: Some(1),
            limit: Some(2),
        },
    )
    .unwrap();
    assert_eq!(messages.total, 4);
    assert_eq!(messages.data.len(), 2);
    assert_eq!(messages.data[0].role, "assistant");

    let search = search_messages(
        &conn,
        &SearchParams {
            q: "Needle".into(),
            project: Some("project-alpha".into()),
            agent: Some("claude".into()),
            sort: Some("recent".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(search.total >= 1);
    assert!(
        search
            .data
            .iter()
            .any(|row| row.session_id == "sess-a" && row.snippet.contains("<mark>"))
    );
    assert_eq!(
        search.data[0].session_project.as_deref(),
        Some("project-alpha")
    );
    assert_eq!(search.data[0].session_agent, "claude");
    assert!(search.data[0].session_first_message.is_some());

    let projects = get_distinct_projects(&conn).unwrap();
    let agents = get_distinct_agents(&conn).unwrap();
    assert_eq!(projects, vec!["project-alpha".to_string()]);
    assert_eq!(agents, vec!["claude".to_string()]);
}

#[test]
fn session_activity_and_pin_queries_work() {
    let conn = setup_db();
    seed_historical_v2(&conn);

    let activity = get_session_activity(&conn, "sess-a").unwrap();
    assert_eq!(activity.total_messages, 4);
    assert_eq!(activity.timestamped_messages, 4);
    assert_eq!(activity.untimestamped_messages, 0);
    assert_eq!(activity.navigation_basis, "timestamp");
    assert_eq!(activity.bucket_count, 8);
    assert_eq!(activity.data.len(), 8);
    assert_eq!(activity.data[0].start_ordinal, Some(0));

    let pinned = pin_message(&conn, "sess-a", 1)
        .unwrap()
        .expect("expected pin");
    assert_eq!(pinned.session_id, "sess-a");
    assert_eq!(pinned.message_id, Some(1));
    assert_eq!(pinned.message_ordinal, 0);
    assert_eq!(pinned.session_project.as_deref(), Some("project-alpha"));

    let session_pins = list_pinned_messages(
        &conn,
        &PinsListParams {
            session_id: Some("sess-a".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(session_pins.len(), 1);
    assert_eq!(session_pins[0].message_ordinal, 0);

    let project_pins = list_pinned_messages(
        &conn,
        &PinsListParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(project_pins.len(), 1);

    conn.execute(
        "DELETE FROM messages WHERE session_id = 'sess-a' AND ordinal = 0",
        [],
    )
    .unwrap();

    let orphaned = list_pinned_messages(
        &conn,
        &PinsListParams {
            session_id: Some("sess-a".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(orphaned[0].message_id, Some(1));
    assert_eq!(orphaned[0].role, None);
    assert_eq!(orphaned[0].content, None);

    let unpinned = unpin_message(&conn, "sess-a", 1).unwrap();
    assert_eq!(unpinned, (true, Some(0)));
}

#[test]
fn relevance_search_prefers_denser_matches_and_returns_cursor() {
    let conn = setup_db();
    seed_relevance_history(&conn);

    let search = search_messages(
        &conn,
        &SearchParams {
            q: "rankmagic".into(),
            project: Some("project-alpha".into()),
            agent: Some("claude".into()),
            sort: Some("relevance".into()),
            limit: Some(2),
            cursor: None,
        },
    )
    .unwrap();

    assert_eq!(search.total, 3);
    assert_eq!(search.data.len(), 2);
    assert_eq!(search.data[0].session_id, "sess-rank-dense");
    assert!(search.cursor.is_some());

    let next_page = search_messages(
        &conn,
        &SearchParams {
            q: "rankmagic".into(),
            project: Some("project-alpha".into()),
            agent: Some("claude".into()),
            sort: Some("relevance".into()),
            limit: Some(2),
            cursor: search.cursor,
        },
    )
    .unwrap();

    assert_eq!(next_page.data.len(), 1);
    assert_eq!(next_page.data[0].session_id, "sess-rank-thin");
}

#[test]
fn analytics_queries_reflect_historical_projection() {
    let conn = setup_db();
    seed_historical_v2(&conn);
    seed_analytics_variant(&conn);

    let summary = get_analytics_summary(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(summary.total_sessions, 3);
    assert_eq!(summary.total_messages, 7);
    assert_eq!(summary.total_user_messages, 4);
    assert!(summary.daily_average_sessions > 0.0);
    assert_eq!(summary.coverage.matching_sessions, 3);
    assert_eq!(summary.coverage.included_sessions, 3);
    assert_eq!(summary.coverage.excluded_sessions, 0);
    assert_eq!(summary.coverage.fidelity_breakdown.full, 2);
    assert_eq!(summary.coverage.fidelity_breakdown.summary, 1);

    let activity = get_analytics_activity(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(activity.len(), 2);
    assert_eq!(activity[0].date, "2026-04-09");
    assert_eq!(activity[0].sessions, 2);
    assert_eq!(activity[0].messages, 5);
    assert_eq!(activity[0].user_messages, 3);

    let projects = get_analytics_projects(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].project, "project-alpha");
    assert_eq!(projects[0].message_count, 7);
    assert_eq!(projects[0].user_message_count, 4);

    let tools = get_analytics_tools(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].tool_name, "Read");
    assert_eq!(tools[0].count, 1);

    let tool_coverage = get_analytics_coverage(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
        "tool_analytics_capable",
    )
    .unwrap();
    assert_eq!(tool_coverage.matching_sessions, 3);
    assert_eq!(tool_coverage.included_sessions, 2);
    assert_eq!(tool_coverage.excluded_sessions, 1);
    assert_eq!(tool_coverage.capability_breakdown.tool_analytics.none, 1);

    let hour_of_week = get_analytics_hour_of_week(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(hour_of_week.len(), 168);
    assert_eq!(
        hour_of_week
            .iter()
            .map(|row| row.session_count)
            .sum::<i64>(),
        3
    );

    let top_sessions = get_analytics_top_sessions(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            limit: Some(2),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(top_sessions.len(), 2);
    assert_eq!(top_sessions[0].id, "sess-a");
    assert_eq!(top_sessions[1].id, "sess-summary");

    let velocity = get_analytics_velocity(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(velocity.total_sessions, 3);
    assert_eq!(velocity.total_messages, 7);
    assert_eq!(velocity.active_days, 2);
    assert_eq!(velocity.span_days, 2);
    assert_eq!(velocity.coverage.matching_sessions, 3);

    let agents = get_analytics_agents(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(agents.len(), 2);
    assert_eq!(agents[0].agent, "claude");
    assert_eq!(agents[0].session_count, 2);
    assert_eq!(agents[1].agent, "codex");
    assert_eq!(agents[1].summary_fidelity_sessions, 1);
    assert_eq!(agents[1].tool_analytics_capable_sessions, 0);
}

#[test]
fn live_queries_return_sessions_turns_and_items() {
    let conn = setup_db();
    seed_historical_v2(&conn);

    let sessions = list_live_sessions(
        &conn,
        &LiveSessionsListParams {
            project: Some("project-alpha".into()),
            agent: Some("claude".into()),
            fidelity: Some("full".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(sessions.total, 2);
    assert_eq!(sessions.data[0].id, "sess-a");

    let live_session = get_live_session(&conn, "sess-a")
        .unwrap()
        .expect("live session");
    assert_eq!(live_session.live_status.as_deref(), Some("ended"));

    let turns = get_session_turns(&conn, "sess-a").unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].source_turn_id.as_deref(), Some("claude-message:0"));

    let items = get_session_items(
        &conn,
        "sess-a",
        &LiveItemsListParams {
            kinds: vec!["reasoning".into(), "tool_call".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(items.total, 4);
    assert_eq!(items.data.len(), 2);
    assert!(
        items
            .data
            .iter()
            .all(|item| matches!(item.kind.as_str(), "reasoning" | "tool_call"))
    );
}
