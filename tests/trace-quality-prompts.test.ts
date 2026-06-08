import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { projectTraceQuality } from '../src/trace-quality/projection.js';
import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;

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
    DELETE FROM browsing_sessions;
    DELETE FROM events;
  `);
}

function seedPromptSession(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, integration_mode, fidelity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'prompt-session',
    'agentmonitor',
    'codex',
    'Generate a trace quality summary',
    '2026-06-08T12:00:00.000Z',
    '2026-06-08T12:00:03.000Z',
    2,
    1,
    'codex-jsonl',
    'full',
  );

  db.prepare(`
    INSERT INTO session_items (
      session_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'prompt-session',
    0,
    'user-1',
    'user_message',
    'success',
    JSON.stringify({ text: 'Generate a trace quality summary' }),
    '2026-06-08T12:00:00.000Z',
    'prompt-session',
    1,
    'assistant-1',
    'assistant_message',
    'success',
    JSON.stringify({
      text: 'Summary complete',
      prompt_name: 'agentmonitor-system',
      prompt_version: '2026-06-08',
      prompt_label: 'prod',
      prompt_hash: 'prompt-hash-2026-06-08',
      prompt_source: 'system_prompt',
      prompt: 'raw prompt body must not be copied into prompt refs',
    }),
    '2026-06-08T12:00:02.000Z',
  );
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-trace-quality-prompts-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'trace-quality.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;

  initSchema();
});

beforeEach(() => {
  clearDatabase();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('explicit event prompt metadata produces a prompt ref without persisting prompt bodies', () => {
  const projection = projectTraceQuality({
    sessionId: 'event-prompt-session',
    agentType: 'codex',
    events: [
      {
        id: 1,
        event_id: 'evt-prompt-1',
        session_id: 'event-prompt-session',
        agent_type: 'codex',
        event_type: 'llm_response',
        tool_name: null,
        status: 'success',
        tokens_in: 32,
        tokens_out: 16,
        branch: 'main',
        project: 'agentmonitor',
        duration_ms: 2500,
        created_at: '2026-06-08T10:00:01.000Z',
        client_timestamp: '2026-06-08T10:00:00.000Z',
        metadata: JSON.stringify({
          content_preview: 'Done',
          prompt_name: 'agentmonitor-system',
          prompt_version: '2026-06-08',
          prompt_label: 'prod',
          prompt_hash: 'explicit-prompt-hash',
          prompt_source: 'system_prompt',
          prompt: 'raw prompt body must not be duplicated',
        }),
        payload_truncated: 0,
        model: 'gpt-5',
        cost_usd: 0.01,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        source: 'otel',
      },
    ],
  });

  assert.equal(projection.observationPrompts.length, 1);
  assert.deepEqual(projection.observationPrompts.map(link => ({
    observation_id: link.observation_id,
    name: link.prompt_ref.name,
    version: link.prompt_ref.version,
    label: link.prompt_ref.label,
    source: link.prompt_ref.source,
    content_hash: link.prompt_ref.content_hash,
  })), [
    {
      observation_id: projection.observations[0]?.id,
      name: 'agentmonitor-system',
      version: '2026-06-08',
      label: 'prod',
      source: 'system_prompt',
      content_hash: 'explicit-prompt-hash',
    },
  ]);
  assert.equal(JSON.parse(projection.traces[0]?.coverage_json ?? '{}').has_prompt_refs, true);
  assert.doesNotMatch(JSON.stringify(projection.observationPrompts), /raw prompt body/);
});

test('explicit session-item prompt metadata wins over inferred Skill tool attribution', () => {
  const projection = projectTraceQuality({
    sessionId: 'skill-session',
    agentType: 'claude_code',
    browsingSession: {
      id: 'skill-session',
      project: 'agentmonitor',
      agent: 'claude_code',
      first_message: 'Use the writing skill',
      started_at: '2026-06-08T11:00:00.000Z',
      ended_at: '2026-06-08T11:00:01.000Z',
      message_count: 1,
      user_message_count: 1,
      parent_session_id: null,
      relationship_type: null,
      live_status: 'idle',
      last_item_at: '2026-06-08T11:00:01.000Z',
      integration_mode: 'claude-jsonl',
      fidelity: 'full',
      capabilities_json: '{}',
      file_path: null,
      file_size: null,
      file_hash: null,
    },
    sessionItems: [
      {
        id: 10,
        session_id: 'skill-session',
        turn_id: null,
        ordinal: 0,
        source_item_id: 'toolu-skill-1',
        kind: 'tool_call',
        status: 'success',
        payload_json: JSON.stringify({
          tool_name: 'Skill',
          input: { skill: 'writing-plans' },
          prompt_name: 'manual-review-prompt',
          prompt_version: 'v2',
          prompt_hash: 'manual-review-hash',
          prompt_source: 'manual',
        }),
        created_at: '2026-06-08T11:00:01.000Z',
      },
    ],
  });

  assert.equal(projection.observationPrompts.length, 1);
  const promptRef = projection.observationPrompts[0]?.prompt_ref;
  assert.equal(promptRef?.name, 'manual-review-prompt');
  assert.equal(promptRef?.version, 'v2');
  assert.equal(promptRef?.source, 'manual');
  assert.equal(promptRef?.content_hash, 'manual-review-hash');
});

test('stable skill prompt refs are inferred from Claude Skill calls and Codex SKILL.md reads', () => {
  const input = {
    sessionId: 'inferred-skill-session',
    agentType: 'codex',
    browsingSession: {
      id: 'inferred-skill-session',
      project: 'agentmonitor',
      agent: 'codex',
      first_message: 'Use skills',
      started_at: '2026-06-08T11:30:00.000Z',
      ended_at: '2026-06-08T11:30:02.000Z',
      message_count: 1,
      user_message_count: 1,
      parent_session_id: null,
      relationship_type: null,
      live_status: 'idle',
      last_item_at: '2026-06-08T11:30:02.000Z',
      integration_mode: 'codex-jsonl',
      fidelity: 'full',
      capabilities_json: '{}',
      file_path: null,
      file_size: null,
      file_hash: null,
    },
    sessionItems: [
      {
        id: 20,
        session_id: 'inferred-skill-session',
        turn_id: null,
        ordinal: 0,
        source_item_id: 'toolu-skill-1',
        kind: 'tool_call',
        status: 'success',
        payload_json: JSON.stringify({ tool_name: 'Skill', input: { skill: 'writing-plans' } }),
        created_at: '2026-06-08T11:30:01.000Z',
      },
      {
        id: 21,
        session_id: 'inferred-skill-session',
        turn_id: null,
        ordinal: 1,
        source_item_id: 'call-read-1',
        kind: 'tool_call',
        status: 'success',
        payload_json: JSON.stringify({
          tool_name: 'Read',
          input: { file_path: '/Users/dg-mac-mini/.agents/skills/first-principles/SKILL.md' },
        }),
        created_at: '2026-06-08T11:30:02.000Z',
      },
    ],
  } as const;

  const first = projectTraceQuality(input);
  const second = projectTraceQuality(input);

  assert.deepEqual(first.observationPrompts, second.observationPrompts);
  assert.deepEqual(first.observationPrompts.map(link => [
    link.prompt_ref.name,
    link.prompt_ref.source,
    link.prompt_ref.file_path,
    typeof link.prompt_ref.content_hash,
  ]), [
    ['skill:writing-plans', 'skill_file', null, 'string'],
    [
      'skill:first-principles',
      'skill_file',
      '/Users/dg-mac-mini/.agents/skills/first-principles/SKILL.md',
      'string',
    ],
  ]);
  assert.equal(JSON.parse(first.traces[0]?.coverage_json ?? '{}').has_prompt_refs, true);
});

test('ambiguous prompt attribution is omitted with warnings', () => {
  const projection = projectTraceQuality({
    sessionId: 'ambiguous-session',
    agentType: 'codex',
    events: [
      {
        id: 2,
        event_id: 'evt-ambiguous-prompt',
        session_id: 'ambiguous-session',
        agent_type: 'codex',
        event_type: 'llm_response',
        tool_name: null,
        status: 'success',
        tokens_in: 1,
        tokens_out: 1,
        branch: null,
        project: null,
        duration_ms: null,
        created_at: '2026-06-08T13:00:00.000Z',
        client_timestamp: null,
        metadata: JSON.stringify({ prompt_version: 'v1', content_preview: 'Missing prompt name' }),
        payload_truncated: 0,
        model: 'gpt-5',
        cost_usd: null,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        source: 'api',
      },
      {
        id: 3,
        event_id: 'evt-ambiguous-skill',
        session_id: 'ambiguous-session',
        agent_type: 'codex',
        event_type: 'tool_use',
        tool_name: 'Read',
        status: 'success',
        tokens_in: 0,
        tokens_out: 0,
        branch: null,
        project: null,
        duration_ms: null,
        created_at: '2026-06-08T13:00:01.000Z',
        client_timestamp: null,
        metadata: JSON.stringify({ input: { file_path: '/tmp/SKILL.md' } }),
        payload_truncated: 0,
        model: null,
        cost_usd: null,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        source: 'api',
      },
    ],
  });

  assert.equal(projection.observationPrompts.length, 0);
  assert.match(projection.warnings.join('\n'), /Ambiguous prompt attribution/);
  assert.equal(JSON.parse(projection.traces[0]?.coverage_json ?? '{}').has_prompt_refs, false);
});

test('backfill persists prompt refs and observation links idempotently', async () => {
  seedPromptSession();
  const { backfillTraceQuality } = await import('../src/trace-quality/service.js');

  const first = backfillTraceQuality({ source: 'sessions', sessionId: 'prompt-session', force: true });
  assert.equal(first.tracesCreated, 1);
  assert.equal(first.observationsCreated, 2);

  const db = getDb();
  assert.deepEqual(db.prepare(`
    SELECT pr.name, pr.version, pr.label, pr.source, pr.content_hash, COUNT(op.observation_id) AS observation_count
    FROM trace_quality_prompt_refs pr
    JOIN trace_quality_observation_prompts op ON op.prompt_ref_id = pr.id
    GROUP BY pr.id
  `).all(), [
    {
      name: 'agentmonitor-system',
      version: '2026-06-08',
      label: 'prod',
      source: 'system_prompt',
      content_hash: 'prompt-hash-2026-06-08',
      observation_count: 1,
    },
  ]);

  backfillTraceQuality({ source: 'sessions', sessionId: 'prompt-session', force: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM trace_quality_prompt_refs').get() as { c: number }).c, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM trace_quality_observation_prompts').get() as { c: number }).c, 1);
});
