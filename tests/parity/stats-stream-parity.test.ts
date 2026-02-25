/**
 * Black-box parity tests for SSE streaming and health endpoints.
 * Runs unchanged against both TypeScript and Rust runtimes.
 *
 * Usage:
 *   AGENTMONITOR_BASE_URL=http://127.0.0.1:3141 node --import tsx --test tests/parity/stats-stream-parity.test.ts
 *   AGENTMONITOR_BASE_URL=http://127.0.0.1:3142 node --import tsx --test tests/parity/stats-stream-parity.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_URL,
  postJson,
  getJson,
  uniqueSession,
} from './helpers/runtime.js';

// ==================== SSE endpoint ====================

test('GET /api/stream returns text/event-stream content type', async () => {
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE_URL}/api/stream`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'), `expected text/event-stream, got ${ct}`);
  } finally {
    controller.abort();
  }
});

test('GET /api/stream sends connected message as first event', async () => {
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE_URL}/api/stream`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read first chunk(s) until we have a complete SSE message
    let buffer = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('\n\n')) break;
    }

    assert.ok(
      buffer.includes('"type"') && buffer.includes('connected'),
      `expected connected message, got: ${buffer.slice(0, 200)}`,
    );
  } finally {
    controller.abort();
  }
});

test('SSE broadcasts ingested events to connected clients', async () => {
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE_URL}/api/stream`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Consume connected message
    let buffer = '';
    const connectDeadline = Date.now() + 3000;
    while (Date.now() < connectDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"connected"')) break;
    }
    assert.ok(buffer.includes('connected'), 'should receive connected message');

    // Now ingest an event
    const session = uniqueSession();
    await postJson('/api/events', {
      session_id: session,
      agent_type: 'claude_code',
      event_type: 'tool_use',
    });

    // Read until we get the event broadcast
    let eventBuffer = '';
    const eventDeadline = Date.now() + 3000;
    while (Date.now() < eventDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      eventBuffer += decoder.decode(value, { stream: true });
      if (eventBuffer.includes('"event"')) break;
    }

    assert.ok(
      eventBuffer.includes('"type"') && eventBuffer.includes('"event"'),
      `expected event broadcast, got: ${eventBuffer.slice(0, 300)}`,
    );
  } finally {
    controller.abort();
  }
});

test('GET /api/health reflects SSE client count', async () => {
  // Wait for previous test SSE connections to fully close
  await new Promise(resolve => setTimeout(resolve, 200));

  // Check baseline — other clients may already be connected
  const before = await getJson('/api/health');
  const healthBefore = await before.json();
  const baselineClients: number = healthBefore.sse_clients;

  // Connect an SSE client
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE_URL}/api/stream`, {
      signal: controller.signal,
    });
    // If we get 503 (max clients reached), skip this test gracefully
    if (res.status === 503) {
      return;
    }
    assert.equal(res.status, 200);

    // Read connected message to ensure client is fully registered
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('connected')) break;
    }
    assert.ok(buffer.includes('connected'), 'should receive connected message');

    // Settle time for the server to update its counter
    await new Promise(resolve => setTimeout(resolve, 100));

    // Health should show incremented client count
    const during = await getJson('/api/health');
    const healthDuring = await during.json();
    assert.ok(
      healthDuring.sse_clients > baselineClients,
      `expected sse_clients > ${baselineClients}, got ${healthDuring.sse_clients}`,
    );
  } finally {
    controller.abort();
  }
});
