/**
 * Black-box parity tests for event ingest endpoints.
 * Runs unchanged against both TypeScript and Rust runtimes.
 *
 * Usage:
 *   AGENTMONITOR_BASE_URL=http://127.0.0.1:3141 node --import tsx --test tests/parity/events-parity.test.ts
 *   AGENTMONITOR_BASE_URL=http://127.0.0.1:3142 node --import tsx --test tests/parity/events-parity.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  postJson,
  getJson,
  uniqueSession,
  uniqueEventId,
} from './helpers/runtime.js';

// ==================== Health ====================

test('GET /api/health returns 200 with expected shape', async () => {
  const res = await getJson('/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.sse_clients, 'number');
});

// ==================== Single event ingest ====================

test('POST /api/events with valid payload returns 201', async () => {
  const res = await postJson('/api/events', {
    session_id: uniqueSession(),
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.01,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.received, 1);
  assert.equal(Array.isArray(body.ids), true);
  assert.equal(body.ids.length, 1);
  assert.equal(body.duplicates, 0);
});

test('POST /api/events auto-calculates cost when model and tokens are provided', async () => {
  const sessionId = uniqueSession();

  const ingest = await postJson('/api/events', {
    session_id: sessionId,
    agent_type: 'codex',
    event_type: 'llm_response',
    model: 'o3',
    tokens_in: 250_000,
    tokens_out: 125_000,
  });
  assert.equal(ingest.status, 201);

  const transcriptRes = await getJson(`/api/sessions/${sessionId}/transcript`);
  assert.equal(transcriptRes.status, 200);
  const transcript = await transcriptRes.json();
  assert.equal(Array.isArray(transcript.entries), true);
  assert.ok(transcript.entries.length > 0);

  const entry = transcript.entries.find((row: { model?: string }) => row.model === 'o3')
    ?? transcript.entries[0];
  assert.equal(entry.model, 'o3');
  assert.ok(typeof entry.cost_usd === 'number');
  assert.ok(entry.cost_usd > 0);
});

test('POST /api/events preserves explicit cost_usd from client', async () => {
  const sessionId = uniqueSession();
  const explicitCost = 12.345;

  const ingest = await postJson('/api/events', {
    session_id: sessionId,
    agent_type: 'codex',
    event_type: 'llm_response',
    model: 'o3',
    tokens_in: 250_000,
    tokens_out: 125_000,
    cost_usd: explicitCost,
  });
  assert.equal(ingest.status, 201);

  const transcriptRes = await getJson(`/api/sessions/${sessionId}/transcript`);
  assert.equal(transcriptRes.status, 200);
  const transcript = await transcriptRes.json();
  const entry = transcript.entries.find((row: { model?: string }) => row.model === 'o3')
    ?? transcript.entries[0];

  assert.equal(entry.model, 'o3');
  assert.equal(typeof entry.cost_usd, 'number');
  assert.ok(Math.abs(entry.cost_usd - explicitCost) < 1e-10);
});

test('POST /api/events missing required fields returns 400', async () => {
  const res = await postJson('/api/events', {
    session_id: uniqueSession(),
    // missing agent_type and event_type
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
  assert.equal(Array.isArray(body.details), true);
  assert.ok(body.details.length > 0);
});

test('POST /api/events missing agent_type returns 400', async () => {
  const res = await postJson('/api/events', {
    session_id: uniqueSession(),
    event_type: 'tool_use',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(Array.isArray(body.details), true);
  const fields = body.details.map((d: { field: string }) => d.field);
  assert.ok(fields.includes('agent_type'));
});

test('POST /api/events missing event_type returns 400', async () => {
  const res = await postJson('/api/events', {
    session_id: uniqueSession(),
    agent_type: 'claude_code',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(Array.isArray(body.details), true);
  const fields = body.details.map((d: { field: string }) => d.field);
  assert.ok(fields.includes('event_type'));
});

test('POST /api/events with non-object body returns 400', async () => {
  const res = await postJson('/api/events', 'just a string');
  assert.equal(res.status, 400);
});

test('POST /api/events dedup: same event_id returns 200 with duplicates=1', async () => {
  const eventId = uniqueEventId();
  const session = uniqueSession();
  const payload = {
    event_id: eventId,
    session_id: session,
    agent_type: 'claude_code',
    event_type: 'tool_use',
  };

  const first = await postJson('/api/events', payload);
  assert.equal(first.status, 201);

  const second = await postJson('/api/events', payload);
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.duplicates, 1);
  assert.equal(body.received, 0);
});

test('POST /api/events with null event_id does not dedup', async () => {
  const session = uniqueSession();
  const payload = {
    event_id: null,
    session_id: session,
    agent_type: 'claude_code',
    event_type: 'tool_use',
  };

  const first = await postJson('/api/events', payload);
  assert.equal(first.status, 201);

  const second = await postJson('/api/events', payload);
  assert.equal(second.status, 201);
});

// ==================== Batch ingest ====================

test('POST /api/events/batch with valid events returns 201', async () => {
  const res = await postJson('/api/events/batch', {
    events: [
      {
        session_id: uniqueSession(),
        agent_type: 'claude_code',
        event_type: 'tool_use',
        tokens_in: 10,
      },
      {
        session_id: uniqueSession(),
        agent_type: 'codex',
        event_type: 'llm_request',
        tokens_in: 20,
      },
    ],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.received, 2);
  assert.equal(body.ids.length, 2);
  assert.equal(body.duplicates, 0);
  assert.equal(Array.isArray(body.rejected), true);
  assert.equal(body.rejected.length, 0);
});

test('POST /api/events/batch missing events key returns 400', async () => {
  const res = await postJson('/api/events/batch', { not_events: [] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('POST /api/events/batch with partial rejection', async () => {
  const res = await postJson('/api/events/batch', {
    events: [
      {
        session_id: uniqueSession(),
        agent_type: 'claude_code',
        event_type: 'tool_use',
      },
      {
        // missing required fields
        session_id: uniqueSession(),
      },
    ],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.received, 1);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].index, 1);
  assert.equal(Array.isArray(body.rejected[0].errors), true);
});

test('POST /api/events/batch dedup counted separately', async () => {
  const eventId = uniqueEventId();
  const session = uniqueSession();

  // Insert original
  await postJson('/api/events', {
    event_id: eventId,
    session_id: session,
    agent_type: 'claude_code',
    event_type: 'tool_use',
  });

  // Batch with same event_id + a new one
  const res = await postJson('/api/events/batch', {
    events: [
      {
        event_id: eventId,
        session_id: session,
        agent_type: 'claude_code',
        event_type: 'tool_use',
      },
      {
        session_id: uniqueSession(),
        agent_type: 'codex',
        event_type: 'llm_request',
      },
    ],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.received, 1);
  assert.equal(body.duplicates, 1);
});

// ==================== Stats ====================

test('GET /api/stats returns expected shape', async () => {
  const res = await getJson('/api/stats');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.total_events, 'number');
  assert.equal(typeof body.active_sessions, 'number');
  assert.equal(typeof body.total_sessions, 'number');
  assert.equal(typeof body.total_tokens_in, 'number');
  assert.equal(typeof body.total_tokens_out, 'number');
  assert.equal(typeof body.total_cost_usd, 'number');
});

test('GET /api/stats reflects ingested events', async () => {
  // Get baseline
  const before = await getJson('/api/stats');
  const statsBefore = await before.json();

  // Ingest an event
  await postJson('/api/events', {
    session_id: uniqueSession(),
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.005,
  });

  // Stats should increase
  const after = await getJson('/api/stats');
  const statsAfter = await after.json();
  assert.ok(statsAfter.total_events > statsBefore.total_events);
  assert.ok(statsAfter.total_tokens_in > statsBefore.total_tokens_in);
  assert.ok(statsAfter.total_tokens_out > statsBefore.total_tokens_out);
});
