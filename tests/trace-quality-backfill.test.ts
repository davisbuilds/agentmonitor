import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let server: Server;
let baseUrl = '';

function countRows(tableName: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number }).c;
}

function clearDatabase(): void {
  getDb().exec(`
    DELETE FROM trace_quality_export_state;
    DELETE FROM trace_quality_projection_state;
    DELETE FROM trace_quality_observation_prompts;
    DELETE FROM trace_quality_prompt_refs;
    DELETE FROM trace_quality_scores;
    DELETE FROM trace_quality_observations;
    DELETE FROM trace_quality_traces;
    DELETE FROM session_items;
    DELETE FROM session_turns;
    DELETE FROM tool_calls;
    DELETE FROM messages;
    DELETE FROM browsing_sessions;
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM agents;
  `);
}

function seedEvent(): number {
  const result = getDb().prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      created_at, client_timestamp, metadata, model, cost_usd, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-backfill-1',
    'event-session',
    'codex',
    'llm_response',
    'success',
    10,
    20,
    '2026-06-07 10:00:01',
    '2026-06-07T10:00:00.000Z',
    '{"content_preview":"Backfilled response"}',
    'gpt-5',
    0.01,
    'api',
  );
  return Number(result.lastInsertRowid);
}

function seedBrowsingSession(): void {
  getDb().prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, integration_mode, fidelity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'session-backfill',
    'agentmonitor',
    'claude_code',
    'Fix a test',
    '2026-06-07T11:00:00.000Z',
    '2026-06-07T11:00:03.000Z',
    2,
    1,
    'claude-jsonl',
    'full',
  );

  getDb().prepare(`
    INSERT INTO session_items (
      session_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'session-backfill',
    0,
    'user-1',
    'user_message',
    'success',
    '{"text":"Fix a test"}',
    '2026-06-07T11:00:00.000Z',
    'session-backfill',
    1,
    'assistant-1',
    'assistant_message',
    'success',
    '{"text":"Done"}',
    '2026-06-07T11:00:02.000Z',
  );
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-trace-quality-backfill-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();
  server = createApp({ serveStatic: false }).listen(0);
  await once(server, 'listening');

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  clearDatabase();
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('backfill dry-run reports projected rows without writing trace-quality tables', async () => {
  seedEvent();
  const { backfillTraceQuality } = await import('../src/trace-quality/service.js');

  const summary = backfillTraceQuality({ source: 'events', dryRun: true });

  assert.equal(summary.sourcesScanned, 1);
  assert.equal(summary.tracesCreated, 1);
  assert.equal(summary.observationsCreated, 1);
  assert.equal(summary.dryRun, true);
  assert.equal(countRows('trace_quality_traces'), 0);
  assert.equal(countRows('trace_quality_observations'), 0);
  assert.equal(countRows('trace_quality_projection_state'), 0);
});

test('backfill is idempotent when projected source payloads are unchanged', async () => {
  seedEvent();
  const { backfillTraceQuality } = await import('../src/trace-quality/service.js');

  const first = backfillTraceQuality({ source: 'events' });
  const second = backfillTraceQuality({ source: 'events' });

  assert.equal(first.sourcesScanned, 1);
  assert.equal(first.tracesCreated, 1);
  assert.equal(first.observationsCreated, 1);
  assert.equal(first.skippedUnchanged, 0);
  assert.equal(second.sourcesScanned, 1);
  assert.equal(second.tracesCreated, 0);
  assert.equal(second.observationsCreated, 0);
  assert.equal(second.skippedUnchanged, 1);
  assert.equal(countRows('trace_quality_traces'), 1);
  assert.equal(countRows('trace_quality_observations'), 1);
  assert.equal(countRows('events'), 1);
});

test('backfill date-only ranges include the full to date', async () => {
  seedEvent();
  getDb().prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      created_at, client_timestamp, metadata, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-backfill-next-day',
    'event-session-next-day',
    'codex',
    'llm_response',
    'success',
    1,
    1,
    '2026-06-08 00:00:00',
    '2026-06-08T00:00:00.000Z',
    '{"content_preview":"Next day response"}',
    'api',
  );
  const { backfillTraceQuality } = await import('../src/trace-quality/service.js');

  const summary = backfillTraceQuality({
    source: 'events',
    from: '2026-06-07',
    to: '2026-06-07',
    dryRun: true,
  });

  assert.equal(summary.sourcesScanned, 1);
  assert.equal(summary.tracesCreated, 1);
  assert.equal(summary.observationsCreated, 1);
  assert.equal(countRows('trace_quality_traces'), 0);
});

test('force backfill rebuilds projected session rows without touching source rows', async () => {
  seedBrowsingSession();
  const { backfillTraceQuality } = await import('../src/trace-quality/service.js');

  const first = backfillTraceQuality({ source: 'sessions' });
  assert.equal(first.tracesCreated, 1);
  assert.equal(first.observationsCreated, 2);

  const trace = getDb().prepare('SELECT id FROM trace_quality_traces WHERE session_id = ?')
    .get('session-backfill') as { id: string };
  getDb().prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, session_id, source_kind, observation_type, name, payload_policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('stale-observation', trace.id, 'session-backfill', 'api', 'event', 'Stale', 'summary_only');
  assert.equal(countRows('trace_quality_observations'), 3);

  const forced = backfillTraceQuality({ source: 'sessions', force: true });

  assert.equal(forced.sourcesScanned, 1);
  assert.equal(forced.tracesUpdated, 1);
  assert.equal(forced.observationsUpdated, 2);
  assert.equal(forced.skippedUnchanged, 0);
  assert.equal(countRows('trace_quality_traces'), 1);
  assert.equal(countRows('trace_quality_observations'), 2);
  assert.equal(countRows('session_items'), 2);
  assert.equal(
    getDb().prepare('SELECT id FROM trace_quality_observations WHERE id = ?').get('stale-observation'),
    undefined,
  );
});

test('event ingest writes trace-quality projection without blocking the primary event row', async () => {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_id: 'evt-api-hook-1',
      session_id: 'api-hook-session',
      agent_type: 'codex',
      event_type: 'llm_response',
      status: 'success',
      tokens_in: 3,
      tokens_out: 5,
      model: 'gpt-5',
      metadata: { content_preview: 'API hook response' },
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(countRows('events'), 1);
  assert.equal(countRows('trace_quality_traces'), 1);
  assert.equal(countRows('trace_quality_observations'), 1);

  const observation = getDb().prepare(`
    SELECT observation_type, payload_policy, output_summary
    FROM trace_quality_observations
  `).get() as { observation_type: string; payload_policy: string; output_summary: string };
  assert.deepEqual(observation, {
    observation_type: 'generation',
    payload_policy: 'summary_only',
    output_summary: 'API hook response',
  });
});
