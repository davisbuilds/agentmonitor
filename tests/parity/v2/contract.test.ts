import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { getJson, postJson, uniqueEventId, uniqueSession, waitFor } from '../helpers/runtime.js';

interface SessionEnvelope {
  id: string;
  project: string | null;
  agent: string;
  integration_mode: string | null;
  fidelity: string | null;
  live_status: string | null;
  message_count: number;
}

const sessionId = 'parity-v2-canonical-session';
const project = 'parity-v2-canonical-project';
const searchNeedle = 'NeedleCanonicalV2';
const usageProject = 'parity-v2-usage-project';

before(async () => {
  await waitFor(async () => {
    const res = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
    if (res.status !== 200) return null;
    return await res.json() as SessionEnvelope;
  }, {
    timeoutMs: 12_000,
    intervalMs: 200,
    message: `Fixture session ${sessionId} never appeared in /api/v2/sessions`,
  });
});

test('fixture-backed Claude session appears in v2 sessions and message endpoints', async () => {
  const listRes = await getJson(`/api/v2/sessions?project=${encodeURIComponent(project)}&agent=claude`);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { data: SessionEnvelope[] };
  const session = listBody.data.find(row => row.id === sessionId);
  assert.ok(session, `expected ${sessionId} in session list`);
  assert.equal(session.project, project);
  assert.equal(session.agent, 'claude');
  assert.equal(session.integration_mode, 'claude-jsonl');
  assert.equal(session.fidelity, 'full');
  assert.ok(['live', 'active'].includes(session.live_status ?? ''), `unexpected live_status ${session.live_status}`);

  const detailRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as SessionEnvelope;
  assert.equal(detail.id, sessionId);
  assert.equal(detail.message_count, 4);

  const messagesRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}/messages`);
  assert.equal(messagesRes.status, 200);
  const messages = await messagesRes.json() as { data: Array<{ role: string }>; total: number };
  assert.equal(messages.total, 4);
  assert.deepEqual(messages.data.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
});

test('fixture-backed Claude session is searchable and reflected in analytics', async () => {
  const searchRes = await getJson(
    `/api/v2/search?q=${encodeURIComponent(searchNeedle)}&project=${encodeURIComponent(project)}&sort=relevance`,
  );
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json() as {
    data: Array<{ session_id: string; snippet: string; session_agent: string; session_project: string | null }>;
    total: number;
  };
  assert.ok(searchBody.total >= 1, 'expected at least one search hit');
  assert.ok(searchBody.data.some(result => result.session_id === sessionId));
  assert.ok(searchBody.data.some(result => result.snippet.includes('<mark>')));
  assert.ok(searchBody.data.some(result => result.session_agent === 'claude'));
  assert.ok(searchBody.data.some(result => result.session_project === project));

  const recentSearchRes = await getJson(
    `/api/v2/search?q=${encodeURIComponent(searchNeedle)}&project=${encodeURIComponent(project)}&sort=recent`,
  );
  assert.equal(recentSearchRes.status, 200);
  const recentSearchBody = await recentSearchRes.json() as { total: number };
  assert.equal(recentSearchBody.total, searchBody.total);

  const summaryRes = await getJson(`/api/v2/analytics/summary?project=${encodeURIComponent(project)}&agent=claude`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json() as {
    total_sessions: number;
    total_messages: number;
    total_user_messages: number;
  };
  assert.equal(summary.total_sessions, 1);
  assert.equal(summary.total_messages, 4);
  assert.equal(summary.total_user_messages, 2);

  const toolsRes = await getJson(`/api/v2/analytics/tools?project=${encodeURIComponent(project)}&agent=claude`);
  assert.equal(toolsRes.status, 200);
  const tools = await toolsRes.json() as { data: Array<{ tool_name: string; count: number }> };
  assert.ok(tools.data.some(tool => tool.tool_name === 'Read' && tool.count >= 1));
});

test('fixture-backed Claude session supports activity buckets and pin round-trip', async () => {
  const activityRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}/activity`);
  assert.equal(activityRes.status, 200);
  const activityBody = await activityRes.json() as {
    bucket_count: number;
    total_messages: number;
    data: Array<{
      bucket_index: number;
      start_ordinal: number | null;
      end_ordinal: number | null;
      message_count: number;
    }>;
  };
  assert.equal(activityBody.total_messages, 4);
  assert.equal(activityBody.data.length, activityBody.bucket_count);
  assert.equal(activityBody.data[0]?.start_ordinal, 0);
  assert.equal(
    Math.max(...activityBody.data.map(bucket => bucket.end_ordinal ?? -1)),
    3,
  );
  assert.equal(activityBody.data.reduce((sum, bucket) => sum + bucket.message_count, 0), 4);

  const messagesRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}/messages?limit=1`);
  assert.equal(messagesRes.status, 200);
  const messagesBody = await messagesRes.json() as {
    data: Array<{ id: number; ordinal: number }>;
  };
  const messageId = messagesBody.data[0]?.id;
  assert.ok(messageId, 'expected a message id to pin');

  const pinRes = await fetch(`${process.env.AGENTMONITOR_BASE_URL ?? 'http://127.0.0.1:3141'}/api/v2/sessions/${encodeURIComponent(sessionId)}/messages/${messageId}/pin`, {
    method: 'POST',
  });
  assert.equal(pinRes.status, 201);
  const pinBody = await pinRes.json() as {
    session_id: string;
    message_id: number | null;
    message_ordinal: number;
    session_project: string | null;
  };
  assert.equal(pinBody.session_id, sessionId);
  assert.equal(pinBody.message_id, messageId);
  assert.equal(pinBody.message_ordinal, 0);
  assert.equal(pinBody.session_project, project);

  const sessionPinsRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}/pins`);
  assert.equal(sessionPinsRes.status, 200);
  const sessionPinsBody = await sessionPinsRes.json() as {
    data: Array<{ session_id: string; message_ordinal: number }>;
  };
  assert.equal(sessionPinsBody.data.length, 1);
  assert.equal(sessionPinsBody.data[0]?.session_id, sessionId);
  assert.equal(sessionPinsBody.data[0]?.message_ordinal, 0);

  const allPinsRes = await getJson(`/api/v2/pins?project=${encodeURIComponent(project)}`);
  assert.equal(allPinsRes.status, 200);
  const allPinsBody = await allPinsRes.json() as {
    data: Array<{ session_id: string }>;
  };
  assert.ok(allPinsBody.data.some(pin => pin.session_id === sessionId));

  const unpinRes = await fetch(`${process.env.AGENTMONITOR_BASE_URL ?? 'http://127.0.0.1:3141'}/api/v2/sessions/${encodeURIComponent(sessionId)}/messages/${messageId}/pin`, {
    method: 'DELETE',
  });
  assert.equal(unpinRes.status, 200);
  const unpinBody = await unpinRes.json() as { removed: boolean; message_ordinal: number | null };
  assert.equal(unpinBody.removed, true);
  assert.equal(unpinBody.message_ordinal, 0);
});

test('advanced analytics routes expose coverage-aware envelopes', async () => {
  const activityRes = await getJson(`/api/v2/analytics/activity?project=${encodeURIComponent(project)}&agent=claude`);
  assert.equal(activityRes.status, 200);
  const activityBody = await activityRes.json() as {
    data: Array<{ date: string; sessions: number; messages: number; user_messages: number }>;
    coverage: { metric_scope: string; matching_sessions: number; included_sessions: number };
  };
  assert.ok(activityBody.data.length >= 1);
  assert.equal(activityBody.coverage.metric_scope, 'all_sessions');
  assert.ok(activityBody.coverage.matching_sessions >= 1);
  assert.ok(
    activityBody.data.every(
      row =>
        typeof row.sessions === 'number' &&
        typeof row.messages === 'number' &&
        typeof row.user_messages === 'number',
    ),
  );

  const projectsRes = await getJson('/api/v2/analytics/projects');
  assert.equal(projectsRes.status, 200);
  const projectsBody = await projectsRes.json() as {
    data: Array<{ project: string; session_count: number; message_count: number }>;
    coverage: { metric_scope: string };
  };
  assert.equal(projectsBody.coverage.metric_scope, 'all_sessions');
  assert.ok(projectsBody.data.some(row => row.project === project));

  const hourOfWeekRes = await getJson(`/api/v2/analytics/hour-of-week?project=${encodeURIComponent(project)}&agent=claude`);
  assert.equal(hourOfWeekRes.status, 200);
  const hourOfWeekBody = await hourOfWeekRes.json() as {
    data: Array<{ day_of_week: number; hour_of_day: number; session_count: number; message_count: number }>;
    coverage: { metric_scope: string };
  };
  assert.equal(hourOfWeekBody.coverage.metric_scope, 'all_sessions');
  assert.ok(hourOfWeekBody.data.some(row => row.message_count >= 1));

  const topSessionsRes = await getJson(`/api/v2/analytics/top-sessions?agent=claude&limit=5`);
  assert.equal(topSessionsRes.status, 200);
  const topSessionsBody = await topSessionsRes.json() as {
    data: Array<{ id: string; project: string | null; agent: string; message_count: number }>;
    coverage: { metric_scope: string };
  };
  assert.equal(topSessionsBody.coverage.metric_scope, 'all_sessions');
  assert.ok(topSessionsBody.data.some(row => row.id === sessionId));

  const velocityRes = await getJson(`/api/v2/analytics/velocity?project=${encodeURIComponent(project)}&agent=claude`);
  assert.equal(velocityRes.status, 200);
  const velocityBody = await velocityRes.json() as {
    total_sessions: number;
    total_messages: number;
    active_days: number;
    coverage: { metric_scope: string };
  };
  assert.equal(velocityBody.coverage.metric_scope, 'all_sessions');
  assert.ok(velocityBody.total_sessions >= 1);
  assert.ok(velocityBody.total_messages >= 4);
  assert.ok(velocityBody.active_days >= 1);

  const agentsRes = await getJson('/api/v2/analytics/agents');
  assert.equal(agentsRes.status, 200);
  const agentsBody = await agentsRes.json() as {
    data: Array<{ agent: string; session_count: number }>;
    coverage: { metric_scope: string; matching_sessions: number };
  };
  assert.equal(agentsBody.coverage.metric_scope, 'all_sessions');
  assert.ok(agentsBody.coverage.matching_sessions >= 2);
  assert.ok(agentsBody.data.some(row => row.agent === 'claude'));
  assert.ok(agentsBody.data.some(row => row.agent === 'codex'));
});

test('usage routes aggregate ingested event usage with coverage metadata', async () => {
  const usageSessionA = uniqueSession();
  const usageSessionB = uniqueSession();
  const usageEvents = [
    {
      event_id: uniqueEventId(),
      session_id: usageSessionA,
      project: usageProject,
      agent_type: 'claude_code',
      event_type: 'response',
      source: 'api',
      status: 'success',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 1000,
      tokens_out: 200,
      cache_read_tokens: 300,
      cache_write_tokens: 50,
      cost_usd: 0.012,
    },
    {
      event_id: uniqueEventId(),
      session_id: usageSessionA,
      project: usageProject,
      agent_type: 'claude_code',
      event_type: 'tool_use',
      source: 'api',
      status: 'success',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 200,
      tokens_out: 100,
      cost_usd: 0.004,
    },
    {
      event_id: uniqueEventId(),
      session_id: usageSessionB,
      project: usageProject,
      agent_type: 'codex',
      event_type: 'response',
      source: 'api',
      status: 'success',
      model: 'gpt-5.4',
      tokens_in: 1500,
      tokens_out: 300,
      cost_usd: 0.02,
    },
  ];

  for (const event of usageEvents) {
    const ingestRes = await postJson('/api/events', event);
    assert.equal(ingestRes.status, 201);
  }

  const summaryBody = await waitFor(async () => {
    const summaryRes = await getJson(`/api/v2/usage/summary?project=${encodeURIComponent(usageProject)}`);
    if (summaryRes.status !== 200) return null;
    const body = await summaryRes.json() as {
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read_tokens: number;
      total_cache_write_tokens: number;
      total_usage_events: number;
      total_sessions: number;
      coverage: { matching_events: number; usage_events: number; matching_sessions: number; usage_sessions: number };
    };
    return body.total_usage_events === 3 ? body : null;
  }, {
    timeoutMs: 5_000,
    intervalMs: 100,
    message: 'usage summary never reflected ingested parity events',
  });

  assert.equal(summaryBody.total_cost_usd, 0.036);
  assert.equal(summaryBody.total_input_tokens, 2700);
  assert.equal(summaryBody.total_output_tokens, 600);
  assert.equal(summaryBody.total_cache_read_tokens, 300);
  assert.equal(summaryBody.total_cache_write_tokens, 50);
  assert.equal(summaryBody.total_usage_events, 3);
  assert.equal(summaryBody.total_sessions, 2);
  assert.equal(summaryBody.coverage.matching_events, 3);
  assert.equal(summaryBody.coverage.usage_events, 3);
  assert.equal(summaryBody.coverage.matching_sessions, 2);
  assert.equal(summaryBody.coverage.usage_sessions, 2);

  const dailyRes = await getJson(`/api/v2/usage/daily?project=${encodeURIComponent(usageProject)}`);
  assert.equal(dailyRes.status, 200);
  const dailyBody = await dailyRes.json() as {
    data: Array<{ date: string; usage_events: number }>;
    coverage: { usage_events: number };
  };
  assert.equal(dailyBody.coverage.usage_events, 3);
  assert.equal(dailyBody.data.reduce((sum, row) => sum + row.usage_events, 0), 3);

  const projectsRes = await getJson(`/api/v2/usage/projects?project=${encodeURIComponent(usageProject)}`);
  assert.equal(projectsRes.status, 200);
  const projectsBody = await projectsRes.json() as {
    data: Array<{ project: string; session_count: number; usage_events: number }>;
  };
  assert.equal(projectsBody.data.length, 1);
  assert.equal(projectsBody.data[0]?.project, usageProject);
  assert.equal(projectsBody.data[0]?.session_count, 2);
  assert.equal(projectsBody.data[0]?.usage_events, 3);

  const modelsRes = await getJson(`/api/v2/usage/models?project=${encodeURIComponent(usageProject)}`);
  assert.equal(modelsRes.status, 200);
  const modelsBody = await modelsRes.json() as {
    data: Array<{ model: string }>;
  };
  assert.ok(modelsBody.data.some(row => row.model === 'claude-sonnet-4-5-20250929'));
  assert.ok(modelsBody.data.some(row => row.model === 'gpt-5.4'));

  const agentsRes = await getJson(`/api/v2/usage/agents?project=${encodeURIComponent(usageProject)}`);
  assert.equal(agentsRes.status, 200);
  const agentsBody = await agentsRes.json() as {
    data: Array<{ agent: string; usage_events: number }>;
  };
  assert.ok(agentsBody.data.some(row => row.agent === 'claude_code' && row.usage_events === 2));
  assert.ok(agentsBody.data.some(row => row.agent === 'codex' && row.usage_events === 1));

  const topSessionsRes = await getJson(`/api/v2/usage/top-sessions?project=${encodeURIComponent(usageProject)}&limit=5`);
  assert.equal(topSessionsRes.status, 200);
  const topSessionsBody = await topSessionsRes.json() as {
    data: Array<{ id: string; browsing_session_available: boolean }>;
  };
  assert.ok(topSessionsBody.data.length >= 1);
  assert.ok(topSessionsBody.data.some(row => row.id === usageSessionA && row.browsing_session_available === false));
  assert.ok(topSessionsBody.data.every(row => typeof row.browsing_session_available === 'boolean'));
});

test('insights list route exposes generation metadata on a fresh parity fixture', async () => {
  const res = await getJson('/api/v2/insights');
  assert.equal(res.status, 200);
  const body = await res.json() as {
    data: unknown[];
    generation: {
      default_provider: string;
      providers: Record<string, { configured: boolean; default_model: string }>;
    };
  };

  assert.deepEqual(body.data, []);
  assert.equal(body.generation.default_provider, 'openai');
  assert.equal(body.generation.providers.openai.default_model, 'gpt-5-mini');
  assert.equal(body.generation.providers.anthropic.default_model, 'claude-sonnet-4-5');
  assert.equal(body.generation.providers.gemini.default_model, 'gemini-2.5-flash');
  assert.equal(typeof body.generation.providers.openai.configured, 'boolean');
});

test('fixture-backed Claude session populates canonical live endpoints with full-fidelity items', async () => {
  const sessionsRes = await getJson(`/api/v2/live/sessions?project=${encodeURIComponent(project)}&agent=claude&fidelity=full`);
  assert.equal(sessionsRes.status, 200);
  const sessionsBody = await sessionsRes.json() as { data: SessionEnvelope[] };
  const session = sessionsBody.data.find(row => row.id === sessionId);
  assert.ok(session, `expected ${sessionId} in live session list`);
  assert.equal(session.integration_mode, 'claude-jsonl');
  assert.equal(session.fidelity, 'full');

  const turnsRes = await getJson(`/api/v2/live/sessions/${encodeURIComponent(sessionId)}/turns`);
  assert.equal(turnsRes.status, 200);
  const turnsBody = await turnsRes.json() as { data: Array<{ title: string | null }> };
  assert.equal(turnsBody.data.length, 4);
  assert.ok(turnsBody.data.some(turn => (turn.title ?? '').includes(searchNeedle)));

  const itemsRes = await getJson(`/api/v2/live/sessions/${encodeURIComponent(sessionId)}/items`);
  assert.equal(itemsRes.status, 200);
  const itemsBody = await itemsRes.json() as { data: Array<{ kind: string }>; total: number };
  assert.ok(itemsBody.total >= 5, `expected >= 5 live items, got ${itemsBody.total}`);
  const kinds = new Set(itemsBody.data.map(item => item.kind));
  assert.ok(kinds.has('user_message'));
  assert.ok(kinds.has('assistant_message'));
  assert.ok(kinds.has('reasoning'));
  assert.ok(kinds.has('tool_call'));
});
