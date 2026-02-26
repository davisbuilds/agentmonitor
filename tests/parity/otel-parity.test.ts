/**
 * Black-box parity tests for OTEL endpoints.
 * Runs unchanged against both TypeScript and Rust runtimes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_URL, getJson, postJson, uniqueSession } from './helpers/runtime.js';

function makeLogPayload(sessionId: string) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: sessionId } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                body: { stringValue: '{}' },
                attributes: [
                  { key: 'event.name', value: { stringValue: 'claude_code.tool_result' } },
                  { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
                  { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: 123 } },
                  { key: 'gen_ai.usage.output_tokens', value: { intValue: 45 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeDeltaMetricsPayload(sessionId: string) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: sessionId } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  dataPoints: [
                    {
                      asInt: '1000',
                      attributes: [
                        { key: 'type', value: { stringValue: 'input' } },
                        { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                      ],
                    },
                    {
                      asInt: '250',
                      attributes: [
                        { key: 'type', value: { stringValue: 'output' } },
                        { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                      ],
                    },
                  ],
                  isMonotonic: true,
                  aggregationTemporality: 1,
                },
              },
              {
                name: 'claude_code.cost.usage',
                sum: {
                  dataPoints: [
                    {
                      asDouble: 0.05,
                      attributes: [
                        { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                      ],
                    },
                  ],
                  isMonotonic: true,
                  aggregationTemporality: 1,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeCumulativeMetricsPayload(sessionId: string, value: number) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: sessionId } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  dataPoints: [
                    {
                      asInt: String(value),
                      attributes: [
                        { key: 'type', value: { stringValue: 'input' } },
                        { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                      ],
                    },
                  ],
                  isMonotonic: true,
                  aggregationTemporality: 2,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function getSessionEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const res = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}?event_limit=50`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.events as Array<Record<string, unknown>>;
}

test('POST /api/otel/v1/logs rejects protobuf content-type', async () => {
  const res = await fetch(`${BASE_URL}/api/otel/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf' },
    body: new Uint8Array([0x0a, 0x00]),
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('POST /api/otel/v1/logs accepts empty JSON payload', async () => {
  const res = await postJson('/api/otel/v1/logs', {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {});
});

test('POST /api/otel/v1/logs ingests mapped event into session detail', async () => {
  const sessionId = uniqueSession();
  const res = await postJson('/api/otel/v1/logs', makeLogPayload(sessionId));
  assert.equal(res.status, 200);

  const events = await getSessionEvents(sessionId);
  assert.ok(events.length >= 1);
  const row = events.find((e) => e.event_type === 'tool_use');
  assert.ok(row, 'expected tool_use event');
  assert.equal(row.tool_name, 'Bash');
  assert.equal(row.source, 'otel');
});

test('POST /api/otel/v1/metrics rejects protobuf content-type', async () => {
  const res = await fetch(`${BASE_URL}/api/otel/v1/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf' },
    body: new Uint8Array([0x0a, 0x00]),
  });
  assert.equal(res.status, 415);
});

test('POST /api/otel/v1/metrics ingests synthetic llm_response events', async () => {
  const sessionId = uniqueSession();
  const res = await postJson('/api/otel/v1/metrics', makeDeltaMetricsPayload(sessionId));
  assert.equal(res.status, 200);

  const events = await getSessionEvents(sessionId);
  assert.ok(events.length >= 2);
  assert.ok(events.some((e) => e.event_type === 'llm_response'));
  assert.ok(events.some((e) => (e.tokens_in as number) === 1000));
  assert.ok(events.some((e) => (e.tokens_out as number) === 250));
  assert.ok(events.some((e) => Number(e.cost_usd ?? 0) > 0));
  assert.ok(events.every((e) => e.source === 'otel'));
});

test('POST /api/otel/v1/metrics supports cumulative-to-delta conversion', async () => {
  const sessionId = uniqueSession();

  const first = await postJson('/api/otel/v1/metrics', makeCumulativeMetricsPayload(sessionId, 1000));
  assert.equal(first.status, 200);
  const second = await postJson('/api/otel/v1/metrics', makeCumulativeMetricsPayload(sessionId, 1500));
  assert.equal(second.status, 200);
  const third = await postJson('/api/otel/v1/metrics', makeCumulativeMetricsPayload(sessionId, 1500));
  assert.equal(third.status, 200);

  const events = await getSessionEvents(sessionId);
  const tokenInValues = events
    .map((e) => Number(e.tokens_in ?? 0))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  assert.ok(tokenInValues.includes(1000));
  assert.ok(tokenInValues.includes(500));
  assert.equal(tokenInValues.filter((n) => n === 0).length, 0);
});

test('POST /api/otel/v1/traces accepts JSON stub and returns empty object', async () => {
  const res = await postJson('/api/otel/v1/traces', { resourceSpans: [] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {});
});
