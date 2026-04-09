import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { EventRow } from '../src/db/queries.js';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let normalizeCodexExporterRecord: typeof import('../src/live/codex-adapter.js').normalizeCodexExporterRecord;
let syncCodexSummaryLiveEvent: typeof import('../src/live/codex-adapter.js').syncCodexSummaryLiveEvent;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-live-codex-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  ({ initSchema } = await import('../src/db/schema.js'));
  ({ normalizeCodexExporterRecord, syncCodexSummaryLiveEvent } = await import('../src/live/codex-adapter.js'));

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeEventRow(overrides: Partial<EventRow> & Pick<EventRow, 'id' | 'session_id' | 'event_type'>): EventRow {
  return {
    id: overrides.id,
    event_id: overrides.event_id ?? `evt-${overrides.id}`,
    schema_version: overrides.schema_version ?? 1,
    session_id: overrides.session_id,
    agent_type: overrides.agent_type ?? 'codex',
    event_type: overrides.event_type,
    tool_name: overrides.tool_name ?? null,
    status: overrides.status ?? 'success',
    tokens_in: overrides.tokens_in ?? 0,
    tokens_out: overrides.tokens_out ?? 0,
    branch: overrides.branch ?? null,
    project: overrides.project ?? '/Users/dg-mac-mini/Dev/agentmonitor',
    duration_ms: overrides.duration_ms ?? null,
    created_at: overrides.created_at ?? '2026-03-24 12:00:00',
    client_timestamp: overrides.client_timestamp ?? '2026-03-24T12:00:00.000Z',
    metadata: overrides.metadata ?? '{}',
    payload_truncated: overrides.payload_truncated ?? 0,
    model: overrides.model ?? null,
    cost_usd: overrides.cost_usd ?? null,
    cache_read_tokens: overrides.cache_read_tokens ?? 0,
    cache_write_tokens: overrides.cache_write_tokens ?? 0,
    source: overrides.source ?? 'otel',
  };
}

test('syncCodexSummaryLiveEvent creates summary session, turn, and user item for OTEL prompt events', () => {
  const db = getDb();
  const row = makeEventRow({
    id: 1,
    session_id: 'codex-summary-001',
    event_type: 'user_prompt',
    metadata: JSON.stringify({ message: 'Summarize the flaky test failures' }),
  });

  const result = syncCodexSummaryLiveEvent(db, row);

  assert.equal(result.inserted_turns, 1);
  assert.equal(result.inserted_items, 1);
  assert.equal(result.fidelity, 'summary');
  assert.equal(result.integration_mode, 'codex-otel');

  const session = db.prepare(`
    SELECT first_message, integration_mode, fidelity, message_count, user_message_count
    FROM browsing_sessions WHERE id = ?
  `).get('codex-summary-001') as {
    first_message: string;
    integration_mode: string;
    fidelity: string;
    message_count: number;
    user_message_count: number;
  };
  const turn = db.prepare('SELECT source_turn_id, title FROM session_turns WHERE session_id = ?').get('codex-summary-001') as {
    source_turn_id: string;
    title: string;
  };
  const item = db.prepare('SELECT kind, payload_json FROM session_items WHERE session_id = ?').get('codex-summary-001') as {
    kind: string;
    payload_json: string;
  };

  assert.equal(session.first_message, 'Summarize the flaky test failures');
  assert.equal(session.integration_mode, 'codex-otel');
  assert.equal(session.fidelity, 'summary');
  assert.equal(session.message_count, 1);
  assert.equal(session.user_message_count, 1);
  assert.equal(turn.source_turn_id, 'evt-1');
  assert.equal(turn.title, 'Summarize the flaky test failures');
  assert.equal(item.kind, 'user_message');
  assert.deepEqual(JSON.parse(item.payload_json), { text: 'Summarize the flaky test failures' });
});

test('syncCodexSummaryLiveEvent redacts tool arguments when capture is disabled', () => {
  const db = getDb();
  const row = makeEventRow({
    id: 2,
    session_id: 'codex-summary-002',
    event_type: 'tool_use',
    tool_name: 'shell',
    metadata: JSON.stringify({ command: 'cat ~/.ssh/config', cwd: '/tmp' }),
  });

  const result = syncCodexSummaryLiveEvent(db, row, {
    privacyPolicy: {
      capturePrompts: true,
      captureReasoning: true,
      captureToolArguments: false,
      diffPayloadMaxBytes: 1024,
    },
  });

  assert.equal(result.inserted_items, 1);

  const item = db.prepare('SELECT kind, payload_json FROM session_items WHERE session_id = ?').get('codex-summary-002') as {
    kind: string;
    payload_json: string;
  };
  const payload = JSON.parse(item.payload_json) as {
    tool_name?: string;
    input?: unknown;
    input_redacted?: boolean;
  };

  assert.equal(item.kind, 'tool_call');
  assert.equal(payload.tool_name, 'shell');
  assert.deepEqual(payload.input, { redacted: true });
  assert.equal(payload.input_redacted, true);
});

test('syncCodexSummaryLiveEvent materializes tool_result items for codex.tool_result metadata', () => {
  const db = getDb();
  const row = makeEventRow({
    id: 3,
    session_id: 'codex-summary-003',
    event_type: 'tool_use',
    tool_name: 'shell',
    status: 'error',
    metadata: JSON.stringify({
      otel_event_name: 'codex.tool_result',
      call_id: 'call-xyz',
      output: 'permission denied',
      success: false,
    }),
  });

  const result = syncCodexSummaryLiveEvent(db, row);
  assert.equal(result.inserted_items, 1);

  const item = db.prepare('SELECT kind, payload_json FROM session_items WHERE session_id = ?').get('codex-summary-003') as {
    kind: string;
    payload_json: string;
  };
  const payload = JSON.parse(item.payload_json) as {
    tool_name?: string;
    output?: string;
    success?: boolean;
  };

  assert.equal(item.kind, 'tool_result');
  assert.equal(payload.tool_name, 'shell');
  assert.equal(payload.output, 'permission denied');
  assert.equal(payload.success, false);
});

test('syncCodexSummaryLiveEvent materializes assistant messages for codex response items', () => {
  const db = getDb();
  const row = makeEventRow({
    id: 4,
    session_id: 'codex-summary-004',
    event_type: 'response',
    metadata: JSON.stringify({
      otel_event_name: 'codex.response',
      response_item_type: 'message_from_assistant',
      content_preview: 'Pinned the Node runtime and updated the docs.',
    }),
  });

  const result = syncCodexSummaryLiveEvent(db, row);
  assert.equal(result.inserted_items, 1);

  const item = db.prepare('SELECT kind, payload_json FROM session_items WHERE session_id = ?').get('codex-summary-004') as {
    kind: string;
    payload_json: string;
  };
  const payload = JSON.parse(item.payload_json) as {
    text?: string;
    item_type?: string;
  };

  assert.equal(item.kind, 'assistant_message');
  assert.equal(payload.text, 'Pinned the Node runtime and updated the docs.');
  assert.equal(payload.item_type, 'message_from_assistant');
});

test('normalizeCodexExporterRecord preserves reserved richer item kinds for future exporters', () => {
  const planItem = normalizeCodexExporterRecord({
    type: 'turn/plan/updated',
    id: 'plan-1',
    created_at: '2026-03-24T12:15:00.000Z',
    payload: {
      steps: [
        { label: 'Inspect telemetry', status: 'completed' },
        { label: 'Document exporter contract', status: 'in_progress' },
      ],
    },
  });
  const diffItem = normalizeCodexExporterRecord({
    type: 'turn/diff/updated',
    id: 'diff-1',
    created_at: '2026-03-24T12:16:00.000Z',
    payload: { files: [{ path: 'src/live/codex-adapter.ts' }] },
  });

  assert.deepEqual(planItem, {
    kind: 'plan_update',
    created_at: '2026-03-24T12:15:00.000Z',
    source_item_id: 'plan-1',
    status: undefined,
    payload: {
      steps: [
        { label: 'Inspect telemetry', status: 'completed' },
        { label: 'Document exporter contract', status: 'in_progress' },
      ],
    },
  });
  assert.deepEqual(diffItem, {
    kind: 'diff_snapshot',
    created_at: '2026-03-24T12:16:00.000Z',
    source_item_id: 'diff-1',
    status: undefined,
    payload: { files: [{ path: 'src/live/codex-adapter.ts' }] },
  });
});
