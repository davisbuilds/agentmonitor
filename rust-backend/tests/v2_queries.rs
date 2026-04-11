use std::path::Path;

use agentmonitor_rs::db;
use agentmonitor_rs::db::v2_queries::{
    AnalyticsParams, MessagesListParams, SearchParams, SessionsListParams, get_analytics_summary,
    get_analytics_tools, get_browsing_session, get_distinct_agents, get_distinct_projects,
    get_session_children, get_session_messages, list_browsing_sessions, search_messages,
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
    conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')", [])
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
            ..Default::default()
        },
    )
    .unwrap();
    assert!(search.total >= 1);
    assert!(search
        .data
        .iter()
        .any(|row| row.session_id == "sess-a" && row.snippet.contains("<mark>")));

    let projects = get_distinct_projects(&conn).unwrap();
    let agents = get_distinct_agents(&conn).unwrap();
    assert_eq!(projects, vec!["project-alpha".to_string()]);
    assert_eq!(agents, vec!["claude".to_string()]);
}

#[test]
fn analytics_queries_reflect_historical_projection() {
    let conn = setup_db();
    seed_historical_v2(&conn);

    let summary = get_analytics_summary(
        &conn,
        &AnalyticsParams {
            project: Some("project-alpha".into()),
            agent: Some("claude".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(summary.total_sessions, 2);
    assert_eq!(summary.total_messages, 5);
    assert_eq!(summary.total_user_messages, 3);
    assert!(summary.daily_average_sessions > 0.0);

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
}
