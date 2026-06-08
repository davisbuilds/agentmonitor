import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { projectTraceQuality } from '../src/trace-quality/projection.js';
import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-trace-quality-projection-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('events project into stable generation observations with honest summary-only coverage', () => {
  const input = {
    sessionId: 'event-session',
    agentType: 'codex',
    project: 'agentmonitor',
    branch: 'main',
    events: [
      {
        id: 42,
        event_id: 'evt-response-42',
        session_id: 'event-session',
        agent_type: 'codex',
        event_type: 'llm_response',
        tool_name: null,
        status: 'success',
        tokens_in: 123,
        tokens_out: 456,
        branch: 'main',
        project: 'agentmonitor',
        duration_ms: 1500,
        created_at: '2026-06-07T10:00:00.000Z',
        client_timestamp: '2026-06-07T09:59:59.000Z',
        metadata: JSON.stringify({ content_preview: 'Completed implementation plan.' }),
        payload_truncated: 0,
        model: 'gpt-5',
        cost_usd: 0.123,
        cache_read_tokens: 12,
        cache_write_tokens: 34,
        source: 'otel',
      },
    ],
  } as const;

  const first = projectTraceQuality(input);
  const second = projectTraceQuality(input);

  assert.deepEqual(first, second);
  assert.equal(first.traces.length, 1);
  assert.equal(first.observations.length, 1);

  const trace = first.traces[0];
  const observation = first.observations[0];
  const coverage = JSON.parse(trace.coverage_json) as Record<string, unknown>;

  assert.equal(trace.session_id, 'event-session');
  assert.equal(trace.source_trace_id, 'evt-response-42');
  assert.equal(trace.started_at, '2026-06-07T09:59:59.000Z');
  assert.equal(trace.duration_ms, 1500);
  assert.equal(coverage.projection_source, 'events');
  assert.equal(coverage.projection_confidence, 'medium');
  assert.equal(coverage.has_token_usage, true);
  assert.equal(coverage.has_cost, true);
  assert.equal(coverage.has_raw_input, false);
  assert.equal(coverage.has_raw_output, false);

  assert.equal(observation.trace_id, trace.id);
  assert.equal(observation.source_kind, 'event');
  assert.equal(observation.source_id, '42');
  assert.equal(observation.observation_type, 'generation');
  assert.equal(observation.model, 'gpt-5');
  assert.equal(observation.tokens_in, 123);
  assert.equal(observation.tokens_out, 456);
  assert.equal(observation.cache_read_tokens, 12);
  assert.equal(observation.cache_write_tokens, 34);
  assert.equal(observation.cost_usd, 0.123);
  assert.equal(observation.payload_policy, 'summary_only');
  assert.equal(observation.output_summary, 'Completed implementation plan.');
  assert.ok(observation.input_hash);
});

test('session turns and items project into trace trees with parent-child tool links', () => {
  const projection = projectTraceQuality({
    sessionId: 'live-session',
    agentType: 'claude_code',
    browsingSession: {
      id: 'live-session',
      project: 'agentmonitor',
      agent: 'claude_code',
      first_message: 'Fix the failing test',
      started_at: '2026-06-07T10:00:00.000Z',
      ended_at: '2026-06-07T10:00:05.000Z',
      message_count: 4,
      user_message_count: 1,
      parent_session_id: null,
      relationship_type: null,
      live_status: 'idle',
      last_item_at: '2026-06-07T10:00:05.000Z',
      integration_mode: 'claude-jsonl',
      fidelity: 'full',
      capabilities_json: JSON.stringify({
        history: 'full',
        search: 'full',
        tool_analytics: 'full',
        live_items: 'full',
      }),
      file_path: null,
      file_size: null,
      file_hash: null,
    },
    turns: [
      {
        id: 7,
        session_id: 'live-session',
        agent_type: 'claude_code',
        source_turn_id: 'turn-7',
        status: 'success',
        title: 'Fix failing test',
        started_at: '2026-06-07T10:00:00.000Z',
        ended_at: '2026-06-07T10:00:05.000Z',
        created_at: '2026-06-07T10:00:00.000Z',
      },
    ],
    sessionItems: [
      {
        id: 10,
        session_id: 'live-session',
        turn_id: 7,
        ordinal: 0,
        source_item_id: 'user-1',
        kind: 'user_message',
        status: 'success',
        payload_json: JSON.stringify({ text: 'Fix the failing test' }),
        created_at: '2026-06-07T10:00:00.000Z',
      },
      {
        id: 11,
        session_id: 'live-session',
        turn_id: 7,
        ordinal: 1,
        source_item_id: 'reasoning-1',
        kind: 'reasoning',
        status: 'success',
        payload_json: JSON.stringify({ text: 'I should inspect the failure first.' }),
        created_at: '2026-06-07T10:00:01.000Z',
      },
      {
        id: 12,
        session_id: 'live-session',
        turn_id: 7,
        ordinal: 2,
        source_item_id: 'toolu-1',
        kind: 'tool_call',
        status: 'success',
        payload_json: JSON.stringify({ tool_name: 'Read', input: { file_path: 'src/app.ts' } }),
        created_at: '2026-06-07T10:00:02.000Z',
      },
      {
        id: 13,
        session_id: 'live-session',
        turn_id: 7,
        ordinal: 3,
        source_item_id: 'toolu-1',
        kind: 'tool_result',
        status: 'success',
        payload_json: JSON.stringify({ content: 'File contents omitted.' }),
        created_at: '2026-06-07T10:00:03.000Z',
      },
    ],
  });

  assert.equal(projection.traces.length, 1);
  assert.equal(projection.observations.length, 4);

  const trace = projection.traces[0];
  const coverage = JSON.parse(trace.coverage_json) as Record<string, unknown>;
  assert.equal(trace.source_trace_id, 'turn-7');
  assert.equal(coverage.projection_source, 'session_turns');
  assert.equal(coverage.projection_confidence, 'high');
  assert.equal(coverage.has_full_transcript, true);
  assert.equal(coverage.has_tool_details, true);
  assert.equal(coverage.has_parent_child_structure, true);
  assert.equal(coverage.has_raw_input, true);
  assert.equal(coverage.has_raw_output, true);
  assert.equal(coverage.has_reasoning, true);

  const toolCall = projection.observations.find(observation => observation.source_id === '12');
  const toolResult = projection.observations.find(observation => observation.source_id === '13');
  assert.equal(toolCall?.observation_type, 'tool');
  assert.equal(toolCall?.tool_name, 'Read');
  assert.equal(toolCall?.payload_policy, 'source_ref');
  assert.equal(toolResult?.parent_observation_id, toolCall?.id);
  assert.equal(toolResult?.observation_type, 'tool');
});

test('messages and tool calls project into one low-risk browsing-session trace when live turns are absent', () => {
  const projection = projectTraceQuality({
    sessionId: 'imported-session',
    agentType: 'claude_code',
    browsingSession: {
      id: 'imported-session',
      project: 'agentmonitor',
      agent: 'claude_code',
      first_message: 'Review this code',
      started_at: '2026-06-07T11:00:00.000Z',
      ended_at: '2026-06-07T11:00:02.000Z',
      message_count: 2,
      user_message_count: 1,
      parent_session_id: null,
      relationship_type: null,
      live_status: null,
      last_item_at: null,
      integration_mode: 'claude-jsonl',
      fidelity: 'full',
      capabilities_json: null,
      file_path: null,
      file_size: null,
      file_hash: null,
    },
    messages: [
      {
        id: 100,
        session_id: 'imported-session',
        ordinal: 0,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'Review this code' }]),
        timestamp: '2026-06-07T11:00:00.000Z',
        has_thinking: 0,
        has_tool_use: 0,
        content_length: 42,
      },
      {
        id: 101,
        session_id: 'imported-session',
        ordinal: 1,
        role: 'assistant',
        content: JSON.stringify([{ type: 'text', text: 'I found one issue.' }]),
        timestamp: '2026-06-07T11:00:01.000Z',
        has_thinking: 0,
        has_tool_use: 1,
        content_length: 44,
      },
    ],
    toolCalls: [
      {
        id: 200,
        message_id: 101,
        session_id: 'imported-session',
        tool_name: 'Read',
        category: 'Read',
        tool_use_id: 'toolu-read-1',
        input_json: JSON.stringify({ file_path: 'src/app.ts' }),
        result_content: null,
        result_content_length: null,
        subagent_session_id: null,
      },
    ],
  });

  assert.equal(projection.traces.length, 1);
  assert.equal(projection.observations.length, 3);

  const coverage = JSON.parse(projection.traces[0].coverage_json) as Record<string, unknown>;
  assert.equal(coverage.projection_source, 'browsing_session');
  assert.equal(coverage.projection_confidence, 'high');
  assert.equal(coverage.has_full_transcript, true);
  assert.equal(coverage.has_tool_details, true);
  assert.equal(coverage.has_parent_child_structure, false);

  const assistant = projection.observations.find(observation => observation.source_kind === 'message' && observation.source_id === '101');
  const tool = projection.observations.find(observation => observation.source_kind === 'tool_call');
  assert.equal(assistant?.observation_type, 'generation');
  assert.equal(assistant?.output_summary, 'I found one issue.');
  assert.equal(tool?.observation_type, 'tool');
  assert.equal(tool?.input_summary, 'file_path: src/app.ts');
});

test('source readers return ordered database rows for projection without mutating sources', async () => {
  const db = getDb();
  db.exec(`
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

  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count, user_message_count,
      integration_mode, fidelity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'reader-session',
    'agentmonitor',
    'codex',
    'Reader test',
    '2026-06-07T12:00:00.000Z',
    '2026-06-07T12:00:03.000Z',
    1,
    1,
    'codex-otel',
    'summary',
  );

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      created_at, client_timestamp, metadata, model, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-reader-1',
    'reader-session',
    'codex',
    'response',
    'success',
    1,
    2,
    '2026-06-07T12:00:02.000Z',
    '2026-06-07T12:00:01.000Z',
    '{"content_preview":"Reader output"}',
    'gpt-5',
    'otel',
  );

  db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('reader-session', 'codex', 'reader-turn', 'success', 'Reader turn', '2026-06-07T12:00:00.000Z', '2026-06-07T12:00:02.000Z');

  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('reader-session', 1, 0, 'item-reader-1', 'assistant_message', 'success', '{"text":"Reader output"}', '2026-06-07T12:00:01.000Z');

  const { readTraceQualityProjectionInputForSession } = await import('../src/trace-quality/source-readers.js');
  const input = readTraceQualityProjectionInputForSession('reader-session');

  assert.equal(input.sessionId, 'reader-session');
  assert.equal(input.agentType, 'codex');
  assert.equal(input.browsingSession?.id, 'reader-session');
  assert.equal(input.events.length, 1);
  assert.equal(input.turns.length, 1);
  assert.equal(input.sessionItems.length, 1);

  const projected = projectTraceQuality(input);
  assert.equal(projected.traces.length, 1);
  assert.equal(projected.observations.length, 1);

  const persistedTraceCount = (db.prepare('SELECT COUNT(*) AS c FROM trace_quality_traces')
    .get() as { c: number }).c;
  assert.equal(persistedTraceCount, 0);
});
