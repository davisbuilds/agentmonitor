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

const sessionId = 'parity-v2-canonical-session';
const project = 'parity-v2-canonical-project';
const searchNeedle = 'NeedleCanonicalV2';

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
  const searchRes = await getJson(`/api/v2/search?q=${encodeURIComponent(searchNeedle)}&project=${encodeURIComponent(project)}`);
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json() as {
    data: Array<{ session_id: string; snippet: string }>;
    total: number;
  };
  assert.ok(searchBody.total >= 1, 'expected at least one search hit');
  assert.ok(searchBody.data.some(result => result.session_id === sessionId));
  assert.ok(searchBody.data.some(result => result.snippet.includes('<mark>')));

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
