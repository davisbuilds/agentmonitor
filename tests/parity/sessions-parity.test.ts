/**
 * Black-box parity tests for sessions, transcript, and filter option endpoints.
 * Runs unchanged against both TypeScript and Rust runtimes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getJson,
  postJson,
  uniqueSession,
} from './helpers/runtime.js';

function uniqueAgentType(): string {
  return `parity_agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueProject(): string {
  return `parity-project-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueBranch(): string {
  return `parity-branch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

test('GET /api/sessions returns expected envelope shape for deterministic filter', async () => {
  const res = await getJson('/api/sessions?agent_type=__parity_no_match__');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body.sessions), true);
  assert.equal(typeof body.total, 'number');
});

test('GET /api/sessions supports agent_type filtering', async () => {
  const sessionId = uniqueSession();
  const agentType = uniqueAgentType();

  const ingest = await postJson('/api/events', {
    session_id: sessionId,
    agent_type: agentType,
    event_type: 'tool_use',
  });
  assert.equal(ingest.status, 201);

  const res = await getJson(`/api/sessions?agent_type=${encodeURIComponent(agentType)}&limit=50`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body.sessions), true);
  assert.ok(body.sessions.some((s: { id: string }) => s.id === sessionId));
});

test('GET /api/sessions/:id returns session detail and event list', async () => {
  const sessionId = uniqueSession();

  await postJson('/api/events', {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'user_prompt',
    metadata: { message: 'hello world' },
  });
  await postJson('/api/events', {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Read',
    metadata: { file_path: '/tmp/file.ts' },
  });

  const res = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}?event_limit=1`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(typeof body.session, 'object');
  assert.equal(body.session.id, sessionId);
  assert.equal(Array.isArray(body.events), true);
  assert.equal(body.events.length, 1);
});

test('GET /api/sessions/:id returns 404 for unknown session', async () => {
  const missingId = uniqueSession();
  const res = await getJson(`/api/sessions/${encodeURIComponent(missingId)}`);
  assert.equal(res.status, 404);

  const body = await res.json();
  assert.equal(body.error, 'Session not found');
});

test('GET /api/sessions/:id/transcript returns transcript entries', async () => {
  const sessionId = uniqueSession();

  await postJson('/api/events', {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'user_prompt',
    metadata: { message: 'Summarize this file' },
  });

  await postJson('/api/events', {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Read',
    metadata: { file_path: 'README.md' },
    status: 'success',
  });

  const res = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.session_id, sessionId);
  assert.equal(Array.isArray(body.entries), true);
  assert.ok(body.entries.length >= 2);

  const roles = body.entries.map((e: { role: string }) => e.role);
  assert.ok(roles.includes('user'));
  assert.ok(roles.includes('tool'));
});

test('GET /api/sessions/:id/transcript returns 404 with no transcript data', async () => {
  const missingId = uniqueSession();
  const res = await getJson(`/api/sessions/${encodeURIComponent(missingId)}/transcript`);
  assert.equal(res.status, 404);

  const body = await res.json();
  assert.equal(body.error, 'No transcript data for this session');
});

test('GET /api/filter-options returns expected shape and includes ingested values', async () => {
  const sessionId = uniqueSession();
  const agentType = uniqueAgentType();
  const project = uniqueProject();
  const branch = uniqueBranch();

  await postJson('/api/events', {
    session_id: sessionId,
    agent_type: agentType,
    event_type: 'tool_use',
    tool_name: 'Edit',
    model: 'gpt-4.1-mini',
    source: 'api',
    project,
    branch,
  });

  const res = await getJson('/api/filter-options');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body.agent_types), true);
  assert.equal(Array.isArray(body.event_types), true);
  assert.equal(Array.isArray(body.tool_names), true);
  assert.equal(Array.isArray(body.models), true);
  assert.equal(Array.isArray(body.projects), true);
  assert.equal(Array.isArray(body.branches), true);
  assert.equal(Array.isArray(body.sources), true);

  assert.ok(body.agent_types.includes(agentType));
  assert.ok(body.event_types.includes('tool_use'));
  assert.ok(body.tool_names.includes('Edit'));
  assert.ok(body.models.includes('gpt-4.1-mini'));
  assert.ok(body.projects.includes(project));
  assert.ok(body.branches.some((b: { value: string }) => b.value === branch));
  assert.ok(body.sources.includes('api'));
});
