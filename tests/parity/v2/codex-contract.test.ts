import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { getJson, waitFor } from '../helpers/runtime.js';

interface SessionEnvelope {
  id: string;
  project: string | null;
  agent: string;
  integration_mode: string | null;
  fidelity: string | null;
  live_status: string | null;
  message_count: number;
}

const sessionId = 'parity-v2-codex-session';
const project = 'parity-v2-codex-project';
const searchNeedle = 'NeedleCodexV2';

before(async () => {
  await waitFor(async () => {
    const res = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
    if (res.status !== 200) return null;
    return await res.json() as SessionEnvelope;
  }, {
    timeoutMs: 12_000,
    intervalMs: 200,
    message: `Codex fixture session ${sessionId} never appeared in /api/v2/sessions`,
  });
});

test('codex session appears in v2 sessions with correct metadata', async () => {
  const listRes = await getJson(`/api/v2/sessions?project=${encodeURIComponent(project)}&agent=codex`);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { data: SessionEnvelope[] };
  const session = listBody.data.find(row => row.id === sessionId);
  assert.ok(session, `expected ${sessionId} in session list`);
  assert.equal(session.project, project);
  assert.equal(session.agent, 'codex');
  assert.equal(session.integration_mode, 'codex-jsonl');
  assert.equal(session.fidelity, 'summary');

  const detailRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as SessionEnvelope;
  assert.equal(detail.id, sessionId);
  assert.ok(detail.message_count >= 4, `expected >= 4 messages, got ${detail.message_count}`);

  const messagesRes = await getJson(`/api/v2/sessions/${encodeURIComponent(sessionId)}/messages`);
  assert.equal(messagesRes.status, 200);
  const messages = await messagesRes.json() as { data: Array<{ role: string; content: string }>; total: number };
  assert.ok(messages.total >= 4, `expected >= 4 messages, got ${messages.total}`);
  const roles = messages.data.map(m => m.role);
  assert.ok(roles.includes('user'), 'expected user messages');
  assert.ok(roles.includes('assistant'), 'expected assistant messages');
});

test('codex session is searchable and reflected in analytics', async () => {
  const searchRes = await getJson(`/api/v2/search?q=${encodeURIComponent(searchNeedle)}&project=${encodeURIComponent(project)}`);
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json() as {
    data: Array<{ session_id: string; snippet: string }>;
    total: number;
  };
  assert.ok(searchBody.total >= 1, 'expected at least one search hit');
  assert.ok(searchBody.data.some(result => result.session_id === sessionId));
  assert.ok(searchBody.data.some(result => result.snippet.includes('<mark>')));

  const summaryRes = await getJson(`/api/v2/analytics/summary?project=${encodeURIComponent(project)}&agent=codex`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json() as {
    total_sessions: number;
    total_messages: number;
    total_user_messages: number;
  };
  assert.equal(summary.total_sessions, 1);
  assert.ok(summary.total_messages >= 4, `expected >= 4 messages in analytics, got ${summary.total_messages}`);
  assert.ok(summary.total_user_messages >= 2, `expected >= 2 user messages, got ${summary.total_user_messages}`);

  const toolsRes = await getJson(`/api/v2/analytics/tools?project=${encodeURIComponent(project)}&agent=codex`);
  assert.equal(toolsRes.status, 200);
  const tools = await toolsRes.json() as { data: Array<{ tool_name: string; count: number }> };
  assert.ok(tools.data.some(tool => tool.tool_name === 'apply_patch' && tool.count >= 1));
});

test('codex session populates live endpoints with summary-fidelity items', async () => {
  const sessionsRes = await getJson(`/api/v2/live/sessions?project=${encodeURIComponent(project)}&agent=codex`);
  assert.equal(sessionsRes.status, 200);
  const sessionsBody = await sessionsRes.json() as { data: SessionEnvelope[] };
  const session = sessionsBody.data.find(row => row.id === sessionId);
  assert.ok(session, `expected ${sessionId} in live session list`);
  assert.equal(session.integration_mode, 'codex-jsonl');
  assert.equal(session.fidelity, 'summary');

  const turnsRes = await getJson(`/api/v2/live/sessions/${encodeURIComponent(sessionId)}/turns`);
  assert.equal(turnsRes.status, 200);
  const turnsBody = await turnsRes.json() as { data: Array<{ title: string | null }> };
  assert.ok(turnsBody.data.length >= 4, `expected >= 4 turns, got ${turnsBody.data.length}`);

  const itemsRes = await getJson(`/api/v2/live/sessions/${encodeURIComponent(sessionId)}/items`);
  assert.equal(itemsRes.status, 200);
  const itemsBody = await itemsRes.json() as { data: Array<{ kind: string }>; total: number };
  assert.ok(itemsBody.total >= 4, `expected >= 4 live items, got ${itemsBody.total}`);
  const kinds = new Set(itemsBody.data.map(item => item.kind));
  assert.ok(kinds.has('user_message'));
  assert.ok(kinds.has('assistant_message'));
  assert.ok(kinds.has('tool_call'));
});
