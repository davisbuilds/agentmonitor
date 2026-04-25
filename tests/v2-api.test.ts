import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';

let server: Server;
let baseUrl = '';
let tempDir = '';
let closeDb: (() => void) | null = null;
let db: Database;
/* eslint-disable @typescript-eslint/consistent-type-imports */
let setInsightGeneratorForTests: typeof import('../src/insights/service.js').setInsightGeneratorForTests;
/* eslint-enable @typescript-eslint/consistent-type-imports */

// Sample session data to seed into the DB
function sampleJsonl(lines: object[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function makeSession(sessionId: string, project: string, msgCount: number, startDate: string) {
  const lines: object[] = [];
  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const ts = new Date(new Date(startDate).getTime() + i * 60_000).toISOString();
    if (role === 'user') {
      lines.push({
        type: 'user',
        parentUuid: i === 0 ? null : `uuid-${i - 1}`,
        sessionId,
        cwd: `/Users/dev/${project}`,
        message: { role: 'user', content: [{ type: 'text', text: `User message ${i} for ${project}` }] },
        timestamp: ts,
      });
    } else {
      const content: object[] = [{ type: 'text', text: `Assistant response ${i}` }];
      if (i === 1) {
        content.push({
          type: 'tool_use',
          id: `toolu_${sessionId}_${i}`,
          name: 'Read',
          input: { file_path: `/Users/dev/${project}/src/index.ts` },
        });
      }
      if (i === 3) {
        content.unshift({ type: 'thinking', thinking: 'Let me consider this...' });
        content.push({
          type: 'tool_use',
          id: `toolu_${sessionId}_${i}`,
          name: 'Bash',
          input: { command: 'npm test' },
        });
      }
      lines.push({
        type: 'assistant',
        parentUuid: `uuid-${i - 1}`,
        sessionId,
        cwd: `/Users/dev/${project}`,
        message: { role: 'assistant', model: 'claude-opus-4-6', content },
        timestamp: ts,
      });
    }
  }
  return sampleJsonl(lines);
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-api-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  initSchema();
  ({ setInsightGeneratorForTests } = await import('../src/insights/service.js'));
  setInsightGeneratorForTests(async (params) => ({
    title: `${params.kind} generated insight`,
    content: `# ${params.kind} generated insight\n\nGenerated for ${params.date_from} to ${params.date_to}.`,
    prompt: 'stub prompt',
    provider: params.provider ?? 'openai',
    model: params.model ?? 'gpt-5-mini',
  }));

  // Seed test data via parser
  const { parseSessionMessages, insertParsedSession } = await import('../src/parser/claude-code.js');
  const { parseCodexSessionMessages } = await import('../src/parser/codex-sessions.js');
  const { insertEvent } = await import('../src/db/queries.js');
  const { syncClaudeLiveSession } = await import('../src/live/claude-adapter.js');
  const { syncCodexLiveSession } = await import('../src/live/codex-adapter.js');
  const {
    SUMMARY_LIVE_PROJECTION_CAPABILITIES,
    upsertProjectedSessionSnapshot,
  } = await import('../src/live/projector.js');
  db = dbModule.getDb();

  // Create 5 sessions across 3 projects with varying sizes
  const sessions = [
    { id: 'api-sess-001', project: 'alpha', msgs: 10, date: '2026-03-01T10:00:00Z' },
    { id: 'api-sess-002', project: 'alpha', msgs: 6, date: '2026-03-02T14:00:00Z' },
    { id: 'api-sess-003', project: 'beta', msgs: 20, date: '2026-03-03T09:00:00Z' },
    { id: 'api-sess-004', project: 'gamma', msgs: 4, date: '2026-03-04T16:00:00Z' },
    { id: 'api-sess-005', project: 'beta', msgs: 8, date: '2026-03-05T11:00:00Z' },
    { id: 'api-tie-001', project: 'tie', msgs: 4, date: '2026-03-06T09:00:00Z' },
    { id: 'api-tie-002', project: 'tie', msgs: 4, date: '2026-03-06T09:00:00Z' },
    { id: 'api-tie-003', project: 'tie', msgs: 4, date: '2026-03-06T09:00:00Z' },
  ];

  for (const s of sessions) {
    const jsonl = makeSession(s.id, s.project, s.msgs, s.date);
    const filePath = `/fake/projects/-Users-dev-Dev-${s.project}/${s.id}.jsonl`;
    const parsed = parseSessionMessages(jsonl, s.id, filePath);
    insertParsedSession(db, parsed, filePath, 1024, `hash_${s.id}`);
    syncClaudeLiveSession(db, parsed);
  }

  const claudeSkillJsonl = sampleJsonl([
    {
      type: 'user',
      parentUuid: null,
      sessionId: 'api-skill-claude-001',
      cwd: '/Users/dev/alpha',
      message: { role: 'user', content: [{ type: 'text', text: 'Plan this feature.' }] },
      timestamp: '2026-03-08T09:00:00Z',
    },
    {
      type: 'assistant',
      parentUuid: 'api-skill-claude-001-user',
      sessionId: 'api-skill-claude-001',
      cwd: '/Users/dev/alpha',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [
          { type: 'text', text: 'Using a planning skill first.' },
          { type: 'tool_use', id: 'toolu_skill_1', name: 'Skill', input: { skill: 'writing-plans' } },
        ],
      },
      timestamp: '2026-03-08T09:01:00Z',
    },
  ]);
  const claudeSkillFilePath = '/fake/projects/-Users-dev-Dev-alpha/api-skill-claude-001.jsonl';
  const claudeSkillParsed = parseSessionMessages(claudeSkillJsonl, 'api-skill-claude-001', claudeSkillFilePath);
  insertParsedSession(db, claudeSkillParsed, claudeSkillFilePath, 512, 'hash_api_skill_claude_001');
  syncClaudeLiveSession(db, claudeSkillParsed);

  const codexSkillSessionId = 'rollout-2026-03-08T11-00-00-019d0000-0000-0000-0000-000000000001';
  const codexSkillJsonl = sampleJsonl([
    {
      type: 'session_meta',
      timestamp: '2026-03-08T11:00:00Z',
      payload: {
        id: '019d0000-0000-0000-0000-000000000001',
        timestamp: '2026-03-08T11:00:00Z',
        cwd: '/Users/dg-mac-mini/Dev/agentmonitor',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-03-08T11:01:00Z',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: "sed -n '1,220p' /Users/dg-mac-mini/.agents/skills/first-principles/SKILL.md",
          workdir: '/Users/dg-mac-mini/Dev/agentmonitor',
        }),
      },
    },
  ]);
  const codexSkillFilePath = `/fake/codex/${codexSkillSessionId}.jsonl`;
  const codexSkillParsed = parseCodexSessionMessages(codexSkillJsonl, codexSkillSessionId, codexSkillFilePath);
  insertParsedSession(db, codexSkillParsed, codexSkillFilePath, 512, 'hash_api_skill_codex_001');
  syncCodexLiveSession(db, codexSkillParsed);

  // Add a child session for relationship testing
  const childJsonl = makeSession('api-sess-006', 'alpha', 4, '2026-03-01T11:00:00Z');
  const childParsed = parseSessionMessages(childJsonl, 'api-sess-006');
  // Manually set parent relationship
  childParsed.metadata.parent_session_id = 'api-sess-001';
  childParsed.metadata.relationship_type = 'subagent';
  insertParsedSession(db, childParsed, '/fake/api-sess-006.jsonl', 512, 'hash_006');
  syncClaudeLiveSession(db, childParsed);

  // Seed one summary-only projected session to exercise capability-aware analytics coverage.
  upsertProjectedSessionSnapshot(db, {
    id: 'api-codex-summary-001',
    agent: 'codex',
    project: 'delta',
    first_message: 'Summarized Codex prompt',
    started_at: '2026-03-07T10:00:00Z',
    ended_at: '2026-03-07T10:05:00Z',
    message_count: 2,
    user_message_count: 1,
    live_status: 'ended',
    last_item_at: '2026-03-07T10:05:00Z',
  }, {
    integration_mode: 'codex-summary',
    fidelity: 'summary',
    capabilities: SUMMARY_LIVE_PROJECTION_CAPABILITIES,
  });

  insertEvent({
    event_id: 'api-codex-live-skill-001',
    session_id: '019d0000-0000-0000-0000-000000000099',
    agent_type: 'codex',
    event_type: 'tool_use',
    tool_name: 'exec_command',
    status: 'success',
    project: 'agentmonitor',
    client_timestamp: '2026-03-09T12:00:00Z',
    metadata: {
      otel_event_name: 'codex.tool_result',
      arguments: {
        cmd: "sed -n '1,220p' /Users/dg-mac-mini/.agents/skills/brainstorming/SKILL.md",
        workdir: '/Users/dg-mac-mini/Dev/agentmonitor',
      },
    },
    source: 'otel',
  });

  const searchRankFixtures = [
    {
      id: 'api-search-rank-001',
      text: 'rankmagic rankmagic rankmagic rankmagic dense transcript match',
      timestamp: '2026-03-08T09:00:00Z',
    },
    {
      id: 'api-search-rank-002',
      text: 'rankmagic sparse transcript match',
      timestamp: '2026-03-08T10:00:00Z',
    },
  ];

  for (const fixture of searchRankFixtures) {
    const jsonl = sampleJsonl([
      {
        type: 'user',
        parentUuid: null,
        sessionId: fixture.id,
        cwd: '/Users/dev/search-rank',
        message: { role: 'user', content: [{ type: 'text', text: fixture.text }] },
        timestamp: fixture.timestamp,
      },
    ]);
    const filePath = `/fake/projects/-Users-dev-Dev-search-rank/${fixture.id}.jsonl`;
    const parsed = parseSessionMessages(jsonl, fixture.id, filePath);
    insertParsedSession(db, parsed, filePath, 256, `hash_${fixture.id}`);
    syncClaudeLiveSession(db, parsed);
  }

  insertEvent({
    event_id: 'api-insight-usage-001',
    session_id: 'api-sess-001',
    agent_type: 'claude_code',
    event_type: 'assistant',
    status: 'success',
    project: 'alpha',
    model: 'claude-sonnet-4-5-20250929',
    tokens_in: 1200,
    tokens_out: 300,
    cost_usd: 0.02,
    client_timestamp: '2026-03-01T10:15:00Z',
    source: 'import',
  });

  // Start server
  const { createApp } = await import('../src/app.js');
  const app = createApp({ serveStatic: false });
  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
  setInsightGeneratorForTests(null);
  if (closeDb) closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// --- Sessions endpoints ---

describe('GET /api/v2/sessions', () => {
  test('returns paginated session list', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[]; total: number };
    assert.ok(body.data.length >= 5, `expected >= 5 sessions, got ${body.data.length}`);
    assert.ok(body.total >= 5);
  });

  test('respects limit parameter', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?limit=2`);
    const body = await res.json() as { data: unknown[]; cursor?: string };
    assert.equal(body.data.length, 2);
    assert.ok(body.cursor, 'should return cursor for pagination');
  });

  test('cursor pagination returns next page', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/sessions?limit=2`);
    const body1 = await res1.json() as { data: Array<{ id: string }>; cursor: string };

    const res2 = await fetch(`${baseUrl}/api/v2/sessions?limit=2&cursor=${body1.cursor}`);
    const body2 = await res2.json() as { data: Array<{ id: string }> };

    // Pages should not overlap
    const ids1 = new Set(body1.data.map(s => s.id));
    for (const s of body2.data) {
      assert.ok(!ids1.has(s.id), `session ${s.id} should not appear in both pages`);
    }
  });

  test('cursor pagination remains stable when sessions share the same started_at', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/sessions?project=tie&limit=2`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json() as { data: Array<{ id: string }>; cursor?: string };
    assert.deepEqual(body1.data.map(session => session.id), ['api-tie-003', 'api-tie-002']);
    assert.ok(body1.cursor);

    const res2 = await fetch(`${baseUrl}/api/v2/sessions?project=tie&limit=2&cursor=${body1.cursor}`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json() as { data: Array<{ id: string }> };
    assert.deepEqual(body2.data.map(session => session.id), ['api-tie-001']);
  });

  test('filters by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?project=alpha`);
    const body = await res.json() as { data: Array<{ project: string }> };
    assert.ok(body.data.length >= 2);
    for (const s of body.data) {
      assert.equal(s.project, 'alpha');
    }
  });

  test('filters by date range', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?date_from=2026-03-03&date_to=2026-03-04`);
    const body = await res.json() as { data: Array<{ started_at: string }> };
    for (const s of body.data) {
      const d = new Date(s.started_at);
      assert.ok(d >= new Date('2026-03-03'), 'should be after date_from');
      assert.ok(d < new Date('2026-03-05'), 'should be before date_to + 1 day');
    }
  });

  test('filters by min_messages', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?min_messages=10`);
    const body = await res.json() as { data: Array<{ message_count: number }> };
    for (const s of body.data) {
      assert.ok(s.message_count >= 10, `expected >= 10 messages, got ${s.message_count}`);
    }
  });

  test('filters by max_messages', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?max_messages=6`);
    const body = await res.json() as { data: Array<{ message_count: number }> };
    assert.ok(body.data.length > 0, 'should have results');
    for (const s of body.data) {
      assert.ok(s.message_count <= 6, `expected <= 6 messages, got ${s.message_count}`);
    }
  });

  test('handles invalid limit gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?limit=notanumber`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length > 0, 'should fall back to default limit');
  });

  test('handles invalid min_messages gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?min_messages=abc`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length > 0, 'should ignore invalid min_messages');
  });

  test('filters by agent', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?agent=claude`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ agent: string }> };
    for (const s of body.data) {
      assert.equal(s.agent, 'claude');
    }
  });

  test('returns sessions ordered by started_at DESC', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions`);
    const body = await res.json() as { data: Array<{ started_at: string }> };
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(body.data[i - 1].started_at >= body.data[i].started_at,
        'sessions should be ordered by started_at DESC');
    }
  });
});

describe('GET /api/v2/sessions/:id', () => {
  test('returns session detail', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001`);
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; project: string; message_count: number };
    assert.equal(body.id, 'api-sess-001');
    assert.equal(body.project, 'alpha');
    assert.equal(body.message_count, 10);
  });

  test('returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/nonexistent`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v2/sessions/:id/messages', () => {
  test('returns messages in ordinal order', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ ordinal: number; role: string }>; total: number };
    assert.equal(body.total, 20);
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(body.data[i].ordinal > body.data[i - 1].ordinal);
    }
  });

  test('supports offset and limit pagination', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages?offset=5&limit=3`);
    const body = await res.json() as { data: Array<{ ordinal: number }>; total: number };
    assert.equal(body.data.length, 3);
    assert.equal(body.data[0].ordinal, 5);
    assert.equal(body.total, 20);
  });

  test('supports centered ordinal window loading', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages?around_ordinal=12&limit=5`);
    const body = await res.json() as { data: Array<{ ordinal: number }>; total: number };
    assert.equal(body.total, 20);
    assert.deepEqual(body.data.map((message) => message.ordinal), [10, 11, 12, 13, 14]);
  });

  test('clamps ordinal windows near transcript bounds', async () => {
    const startRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages?around_ordinal=1&limit=5`);
    const startBody = await startRes.json() as { data: Array<{ ordinal: number }>; total: number };
    assert.deepEqual(startBody.data.map((message) => message.ordinal), [0, 1, 2, 3, 4]);

    const endRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages?around_ordinal=19&limit=5`);
    const endBody = await endRes.json() as { data: Array<{ ordinal: number }>; total: number };
    assert.deepEqual(endBody.data.map((message) => message.ordinal), [15, 16, 17, 18, 19]);
  });

  test('returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/nonexistent/messages`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v2/sessions/:id/activity', () => {
  test('returns bucketed session activity coverage across the transcript', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/activity`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      bucket_count: number;
      total_messages: number;
      first_timestamp: string | null;
      last_timestamp: string | null;
      timestamped_messages: number;
      untimestamped_messages: number;
      navigation_basis: string;
      data: Array<{
        bucket_index: number;
        start_ordinal: number | null;
        end_ordinal: number | null;
        message_count: number;
      }>;
    };

    assert.equal(body.total_messages, 20);
    assert.equal(body.timestamped_messages, 20);
    assert.equal(body.untimestamped_messages, 0);
    assert.equal(body.navigation_basis, 'timestamp');
    assert.ok(body.bucket_count >= 8);
    assert.equal(body.data.length, body.bucket_count);
    assert.equal(body.data[0]?.start_ordinal, 0);
    assert.equal(body.data.at(-1)?.end_ordinal, 19);
    assert.equal(body.data.reduce((sum, bucket) => sum + bucket.message_count, 0), 20);
  });

  test('returns 404 for missing session activity', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/nonexistent/activity`);
    assert.equal(res.status, 404);
  });
});

describe('GET/POST/DELETE /api/v2 pins', () => {
  test('pins, lists, and unpins a message', async () => {
    const messagesRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/messages?limit=1`);
    assert.equal(messagesRes.status, 200);
    const messagesBody = await messagesRes.json() as { data: Array<{ id: number; ordinal: number }> };
    const messageId = messagesBody.data[0]?.id;
    assert.ok(messageId, 'expected a message id to pin');

    const pinRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/messages/${messageId}/pin`, {
      method: 'POST',
    });
    assert.equal(pinRes.status, 201);
    const pinBody = await pinRes.json() as {
      session_id: string;
      message_id: number | null;
      message_ordinal: number;
      session_project: string | null;
    };
    assert.equal(pinBody.session_id, 'api-sess-001');
    assert.equal(pinBody.message_id, messageId);
    assert.equal(pinBody.message_ordinal, 0);
    assert.equal(pinBody.session_project, 'alpha');

    const sessionPinsRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/pins`);
    assert.equal(sessionPinsRes.status, 200);
    const sessionPinsBody = await sessionPinsRes.json() as {
      data: Array<{ session_id: string; message_ordinal: number }>;
    };
    assert.equal(sessionPinsBody.data.length, 1);
    assert.equal(sessionPinsBody.data[0]?.message_ordinal, 0);

    const allPinsRes = await fetch(`${baseUrl}/api/v2/pins?project=alpha`);
    assert.equal(allPinsRes.status, 200);
    const allPinsBody = await allPinsRes.json() as {
      data: Array<{ session_id: string }>;
    };
    assert.ok(allPinsBody.data.some((pin) => pin.session_id === 'api-sess-001'));

    const unpinRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/messages/${messageId}/pin`, {
      method: 'DELETE',
    });
    assert.equal(unpinRes.status, 200);
    const unpinBody = await unpinRes.json() as { removed: boolean; message_ordinal: number | null };
    assert.equal(unpinBody.removed, true);
    assert.equal(unpinBody.message_ordinal, 0);

    const emptyPinsRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/pins`);
    assert.equal(emptyPinsRes.status, 200);
    const emptyPinsBody = await emptyPinsRes.json() as { data: unknown[] };
    assert.equal(emptyPinsBody.data.length, 0);
  });

  test('pins survive message row replacement because they are keyed by ordinal', async () => {
    const messagesRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-002/messages?limit=1`);
    assert.equal(messagesRes.status, 200);
    const messagesBody = await messagesRes.json() as { data: Array<{ id: number }> };
    const originalMessageId = messagesBody.data[0]?.id;
    assert.ok(originalMessageId, 'expected original message id');

    const pinRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-002/messages/${originalMessageId}/pin`, {
      method: 'POST',
    });
    assert.equal(pinRes.status, 201);

    const { parseSessionMessages, insertParsedSession } = await import('../src/parser/claude-code.js');
    const filePath = '/fake/projects/-Users-dev-Dev-alpha/api-sess-002.jsonl';
    const parsed = parseSessionMessages(
      makeSession('api-sess-002', 'alpha', 6, '2026-03-02T14:00:00Z'),
      'api-sess-002',
      filePath,
    );
    insertParsedSession(db, parsed, filePath, 1024, 'hash_api_sess_002_reparse');

    const pinsRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-002/pins`);
    assert.equal(pinsRes.status, 200);
    const pinsBody = await pinsRes.json() as {
      data: Array<{
        message_id: number | null;
        message_ordinal: number;
        role: string | null;
        content: string | null;
      }>;
    };
    assert.equal(pinsBody.data.length, 1);
    assert.equal(pinsBody.data[0]?.message_ordinal, 0);
    assert.notEqual(pinsBody.data[0]?.message_id, originalMessageId);
    assert.equal(pinsBody.data[0]?.role, 'user');
    assert.ok(pinsBody.data[0]?.content, 're-linked pin should still expose current message content');
  });

  test('pins keep a removable message id even when the joined transcript row is absent', async () => {
    const messagesRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages?limit=1`);
    assert.equal(messagesRes.status, 200);
    const messagesBody = await messagesRes.json() as { data: Array<{ id: number; ordinal: number }> };
    const messageId = messagesBody.data[0]?.id;
    assert.ok(messageId, 'expected a message id to pin');

    const pinRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages/${messageId}/pin`, {
      method: 'POST',
    });
    assert.equal(pinRes.status, 201);

    db.prepare(`
      DELETE FROM messages
      WHERE session_id = ? AND ordinal = ?
    `).run('api-sess-003', 0);

    const pinsRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/pins`);
    assert.equal(pinsRes.status, 200);
    const pinsBody = await pinsRes.json() as {
      data: Array<{
        message_id: number | null;
        message_ordinal: number;
        role: string | null;
        content: string | null;
      }>;
    };

    assert.equal(pinsBody.data.length, 1);
    assert.equal(pinsBody.data[0]?.message_id, messageId);
    assert.equal(pinsBody.data[0]?.message_ordinal, 0);
    assert.equal(pinsBody.data[0]?.role, null);
    assert.equal(pinsBody.data[0]?.content, null);

    const unpinRes = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages/${messageId}/pin`, {
      method: 'DELETE',
    });
    assert.equal(unpinRes.status, 200);
    const unpinBody = await unpinRes.json() as { removed: boolean; message_ordinal: number | null };
    assert.equal(unpinBody.removed, true);
    assert.equal(unpinBody.message_ordinal, 0);
  });
});

describe('GET /api/v2/sessions/:id/children', () => {
  test('returns child sessions', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/children`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: string; relationship_type: string }> };
    assert.ok(body.data.length >= 1);
    assert.ok(body.data.some(s => s.id === 'api-sess-006'));
  });

  test('returns empty array for session with no children', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-004/children`);
    const body = await res.json() as { data: unknown[] };
    assert.equal(body.data.length, 0);
  });
});

// --- Live endpoints ---

describe('GET /api/v2/live/settings', () => {
  test('returns live settings and capture metadata', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/settings`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      enabled: boolean;
      codex_mode: string;
      capture: { prompts: boolean; reasoning: boolean; tool_arguments: boolean };
      diff_payload_max_bytes: number;
    };
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(body.codex_mode, 'otel-only');
    assert.equal(typeof body.capture.prompts, 'boolean');
    assert.equal(typeof body.capture.reasoning, 'boolean');
    assert.equal(typeof body.capture.tool_arguments, 'boolean');
    assert.equal(typeof body.diff_payload_max_bytes, 'number');
  });
});

describe('GET /api/v2/live/sessions', () => {
  test('returns live sessions with fidelity metadata', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{
        id: string;
        integration_mode: string | null;
        fidelity: string | null;
        capabilities: { history: string; search: string; tool_analytics: string; live_items: string } | null;
      }>;
      total: number;
    };
    assert.ok(body.data.length >= 6);
    assert.ok(body.total >= 6);
    assert.ok(body.data.some(session => session.integration_mode === 'claude-jsonl'));
    assert.ok(body.data.some(session => session.fidelity === 'full'));
    const claudeSession = body.data.find(session => session.integration_mode === 'claude-jsonl');
    assert.deepEqual(claudeSession?.capabilities, {
      history: 'full',
      search: 'full',
      tool_analytics: 'full',
      live_items: 'full',
    });
  });

  test('filters live sessions by agent and live_status', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions?agent=claude&live_status=ended`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ agent: string; live_status: string | null }> };
    assert.ok(body.data.length > 0);
    for (const session of body.data) {
      assert.equal(session.agent, 'claude');
      assert.equal(session.live_status, 'ended');
    }
  });

  test('live session pagination remains stable when sessions share the same sort timestamp', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/live/sessions?project=tie&limit=2`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json() as { data: Array<{ id: string }>; cursor?: string };
    assert.deepEqual(body1.data.map(session => session.id), ['api-tie-003', 'api-tie-002']);
    assert.ok(body1.cursor);

    const res2 = await fetch(`${baseUrl}/api/v2/live/sessions?project=tie&limit=2&cursor=${body1.cursor}`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json() as { data: Array<{ id: string }> };
    assert.deepEqual(body2.data.map(session => session.id), ['api-tie-001']);
  });
});

describe('GET /api/v2/live/sessions/:id', () => {
  test('returns live session detail', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-001`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      id: string;
      integration_mode: string | null;
      fidelity: string | null;
      capabilities: { history: string; search: string; tool_analytics: string; live_items: string } | null;
    };
    assert.equal(body.id, 'api-sess-001');
    assert.equal(body.integration_mode, 'claude-jsonl');
    assert.equal(body.fidelity, 'full');
    assert.deepEqual(body.capabilities, {
      history: 'full',
      search: 'full',
      tool_analytics: 'full',
      live_items: 'full',
    });
  });

  test('returns 404 for missing live session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/missing-live-session`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v2/live/sessions/:id/turns', () => {
  test('returns live turns for a session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-001/turns`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ session_id: string; source_turn_id: string }> };
    assert.ok(body.data.length > 0);
    assert.equal(body.data[0].session_id, 'api-sess-001');
    assert.ok(body.data[0].source_turn_id.startsWith('claude-message:'));
  });
});

describe('GET /api/v2/live/sessions/:id/items', () => {
  test('returns live items in ascending id order', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-001/items`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: number; kind: string }>; total: number };
    assert.ok(body.data.length > 0);
    assert.ok(body.total >= body.data.length);
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(body.data[i].id > body.data[i - 1].id);
    }
  });

  test('filters live items by kind', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-003/items?kinds=reasoning`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ kind: string }> };
    assert.ok(body.data.length > 0);
    for (const item of body.data) {
      assert.equal(item.kind, 'reasoning');
    }
  });

  test('supports cursor pagination for live items', async () => {
    const first = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-003/items?limit=2`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { data: Array<{ id: number }>; cursor?: string };
    assert.equal(firstBody.data.length, 2);
    assert.ok(firstBody.cursor);

    const second = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-003/items?limit=2&cursor=${firstBody.cursor}`);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { data: Array<{ id: number }> };
    assert.ok(secondBody.data.length > 0);
    assert.ok(secondBody.data[0].id > firstBody.data[firstBody.data.length - 1].id);
  });
});

// --- Search endpoint ---

describe('GET /api/v2/search', () => {
  test('returns matching results for FTS query', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=alpha`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{
        session_id: string;
        snippet: string;
        session_agent: string;
        session_project: string | null;
        session_started_at: string | null;
      }>;
    };
    assert.ok(body.data.length > 0, 'should find results for "alpha"');
    assert.ok(body.data[0]?.session_agent, 'search results should include session agent context');
  });

  test('returns 400 without query parameter', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search`);
    assert.equal(res.status, 400);
  });

  test('filters search by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=message&project=gamma`);
    const body = await res.json() as { data: Array<{ session_id: string }> };
    // All results should be from gamma project sessions
    for (const r of body.data) {
      assert.equal(r.session_id, 'api-sess-004', 'should only return gamma sessions');
    }
  });

  test('respects limit parameter', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=message&limit=3`);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length <= 3);
  });

  test('includes snippet with match context', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=Assistant`);
    const body = await res.json() as { data: Array<{ snippet: string }> };
    if (body.data.length > 0) {
      assert.ok(body.data[0].snippet, 'should include snippet');
    }
  });

  test('returns 400 for invalid FTS5 syntax', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=${encodeURIComponent('"unclosed')}`);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('syntax'), 'error should mention syntax');
  });

  test('cursor pagination returns next page without overlap', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/search?q=message&limit=3`);
    const body1 = await res1.json() as { data: Array<{ message_id: number }>; cursor?: string };

    if (body1.cursor) {
      const res2 = await fetch(`${baseUrl}/api/v2/search?q=message&limit=3&cursor=${body1.cursor}`);
      const body2 = await res2.json() as { data: Array<{ message_id: number }> };

      const ids1 = new Set(body1.data.map(r => r.message_id));
      for (const r of body2.data) {
        assert.ok(!ids1.has(r.message_id), `message_id ${r.message_id} should not appear in both pages`);
      }
    }
  });

  test('filters search by agent', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=message&agent=claude`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(Array.isArray(body.data));
  });

  test('supports relevance sorting for denser transcript matches', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=rankmagic&sort=relevance&limit=2`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ session_id: string }>; cursor?: string };
    assert.equal(body.data[0]?.session_id, 'api-search-rank-001');
    assert.ok(body.cursor, 'relevance search should return a cursor when the page is full');
  });
});

// --- Analytics endpoints ---

describe('GET /api/v2/analytics/summary', () => {
  test('returns correct totals', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/summary`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      total_sessions: number;
      total_messages: number;
      daily_average_sessions: number;
      date_range: { earliest: string | null; latest: string | null };
      coverage: {
        metric_scope: string;
        matching_sessions: number;
        included_sessions: number;
        excluded_sessions: number;
        fidelity_breakdown: { full: number; summary: number; unknown: number };
      };
    };
    assert.ok(body.total_sessions >= 7, `expected >= 7 sessions, got ${body.total_sessions}`);
    assert.ok(body.total_messages > 0);
    assert.ok(typeof body.daily_average_sessions === 'number');
    assert.ok(body.date_range.earliest);
    assert.ok(body.date_range.latest);
    assert.equal(body.coverage.metric_scope, 'all_sessions');
    assert.equal(body.coverage.included_sessions, body.coverage.matching_sessions);
    assert.equal(body.coverage.excluded_sessions, 0);
    assert.ok(body.coverage.fidelity_breakdown.summary >= 1);
  });

  test('filters summary by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/summary?project=alpha`);
    assert.equal(res.status, 200);
    const body = await res.json() as { total_sessions: number };
    // Alpha has 2 sessions + 1 child = 3
    assert.ok(body.total_sessions >= 2 && body.total_sessions <= 4, `expected 2-4 alpha sessions, got ${body.total_sessions}`);
  });

  test('filters summary by date range', async () => {
    const all = await fetch(`${baseUrl}/api/v2/analytics/summary`);
    const allBody = await all.json() as { total_sessions: number };

    const filtered = await fetch(`${baseUrl}/api/v2/analytics/summary?date_from=2026-03-04`);
    const filteredBody = await filtered.json() as { total_sessions: number };
    assert.ok(filteredBody.total_sessions < allBody.total_sessions, 'filtered should have fewer sessions');
  });
});

describe('GET /api/v2/analytics/activity', () => {
  test('returns daily activity data', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/activity`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ date: string; sessions: number; messages: number }> };
    assert.ok(body.data.length > 0);
    for (const point of body.data) {
      assert.ok(point.date, 'should have date');
      assert.ok(typeof point.sessions === 'number');
      assert.ok(typeof point.messages === 'number');
    }
  });

  test('filters by date range', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/activity?date_from=2026-03-03&date_to=2026-03-05`);
    const body = await res.json() as { data: Array<{ date: string }> };
    for (const point of body.data) {
      assert.ok(point.date >= '2026-03-03');
      assert.ok(point.date <= '2026-03-05');
    }
  });

  test('filters by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/activity?project=beta`);
    const body = await res.json() as { data: Array<{ sessions: number }> };
    assert.ok(body.data.length > 0);
  });
});

describe('GET /api/v2/analytics/projects', () => {
  test('returns per-project breakdown', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ project: string; session_count: number; message_count: number }> };
    assert.ok(body.data.length >= 3, 'should have at least 3 projects');
    for (const p of body.data) {
      assert.ok(p.project);
      assert.ok(p.session_count > 0);
      assert.ok(p.message_count > 0);
    }
  });
});

describe('GET /api/v2/analytics/tools', () => {
  test('returns tool usage stats', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/tools`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{ tool_name: string; category: string; count: number }>;
      coverage: {
        metric_scope: string;
        matching_sessions: number;
        included_sessions: number;
        excluded_sessions: number;
      };
    };
    assert.ok(body.data.length > 0, 'should have tool usage data');
    // We know Read and Bash were inserted
    assert.ok(body.data.some(t => t.tool_name === 'Read'));
    assert.equal(body.coverage.metric_scope, 'tool_analytics_capable');
    assert.ok(body.coverage.excluded_sessions >= 1, 'expected summary-only sessions to be excluded from tool analytics');
  });

  test('respects agent filter and reports excluded capability-limited sessions', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/tools?agent=codex`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{ tool_name: string; count: number }>;
      coverage: {
        matching_sessions: number;
        included_sessions: number;
        excluded_sessions: number;
      };
    };
    assert.ok(body.coverage.matching_sessions >= 1);
    assert.equal(
      body.coverage.matching_sessions,
      body.coverage.included_sessions + body.coverage.excluded_sessions,
    );
    assert.ok(body.coverage.excluded_sessions >= 1);
  });
});

describe('GET /api/v2/monitor/tools', () => {
  test('returns event-derived tool analytics in the monitor widget shape', async () => {
    const res = await fetch(`${baseUrl}/api/v2/monitor/tools?agent=codex&date_from=2026-03-09`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      tools: Array<{
        tool_name: string;
        total_calls: number;
        error_count: number;
        error_rate: number;
        avg_duration_ms: number | null;
        by_agent: Record<string, number>;
      }>;
    };

    const row = body.tools.find(tool => tool.tool_name === 'exec_command');
    assert.ok(row, 'expected seeded exec_command tool row');
    assert.equal(row.total_calls, 1);
    assert.equal(row.error_count, 0);
    assert.equal(row.error_rate, 0);
    assert.equal(row.avg_duration_ms, null);
    assert.equal(row.by_agent.codex, 1);
  });
});

describe('GET /api/v2/monitor/sessions', () => {
  test('returns live monitor session aggregates in the monitor widget shape', async () => {
    const res = await fetch(`${baseUrl}/api/v2/monitor/sessions?agent=codex&exclude_status=ended`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      sessions: Array<{
        id: string;
        agent_id: string;
        agent_type: string;
        project: string | null;
        status: string;
        event_count: number;
        tokens_in: number;
        tokens_out: number;
        total_cost_usd: number;
        files_edited: number;
        lines_added: number;
        lines_removed: number;
      }>;
      total: number;
    };

    const row = body.sessions.find(session => session.id === '019d0000-0000-0000-0000-000000000099');
    assert.ok(row, 'expected seeded codex monitor session row');
    assert.equal(row.agent_id, 'codex-default');
    assert.equal(row.agent_type, 'codex');
    assert.equal(row.project, 'agentmonitor');
    assert.equal(row.status, 'active');
    assert.equal(row.event_count, 1);
    assert.equal(row.tokens_in, 0);
    assert.equal(row.tokens_out, 0);
    assert.equal(row.total_cost_usd, 0);
    assert.equal(row.files_edited, 0);
    assert.equal(row.lines_added, 0);
    assert.equal(row.lines_removed, 0);
    assert.ok(body.total >= 1);
  });
});

describe('GET /api/v2/monitor/events', () => {
  test('returns filtered monitor events in the monitor feed shape', async () => {
    const res = await fetch(`${baseUrl}/api/v2/monitor/events?agent=codex&source=otel&limit=1`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      events: Array<{
        event_id: string | null;
        session_id: string;
        agent_type: string;
        event_type: string;
        tool_name: string | null;
        status: string;
        source: string;
      }>;
      total: number;
    };

    assert.equal(body.events.length, 1);
    assert.ok(body.total >= 1);
    const row = body.events[0];
    assert.equal(row.event_id, 'api-codex-live-skill-001');
    assert.equal(row.session_id, '019d0000-0000-0000-0000-000000000099');
    assert.equal(row.agent_type, 'codex');
    assert.equal(row.event_type, 'tool_use');
    assert.equal(row.tool_name, 'exec_command');
    assert.equal(row.status, 'success');
    assert.equal(row.source, 'otel');
  });
});

describe('GET /api/v2/monitor/stats', () => {
  test('returns monitor summary stats and provider quota aliases', async () => {
    const res = await fetch(`${baseUrl}/api/v2/monitor/stats?agent=codex`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      total_events: number;
      active_sessions: number;
      live_sessions: number;
      total_sessions: number;
      active_agents: number;
      total_tokens_in: number;
      total_tokens_out: number;
      total_cost_usd: number;
      tool_breakdown: Record<string, number>;
      agent_breakdown: Record<string, number>;
      model_breakdown: Record<string, number>;
      branches: string[];
      quota_monitor: Array<Record<string, unknown>>;
      usage_monitor: Array<Record<string, unknown>>;
    };

    assert.ok(body.total_events >= 1);
    assert.ok(body.live_sessions >= 1);
    assert.ok(body.total_sessions >= 1);
    assert.equal(body.agent_breakdown.codex, body.total_events);
    assert.equal(body.tool_breakdown.exec_command, 1);
    assert.ok(Array.isArray(body.branches));
    assert.ok(Array.isArray(body.quota_monitor));
    assert.equal(body.quota_monitor.length, 2);
    assert.deepEqual(body.usage_monitor, body.quota_monitor);
  });
});

describe('GET /api/v2/analytics/skills/daily', () => {
  test('returns explicit Claude skills and inferred Codex skills by day', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/skills/daily?date_from=2026-03-08&date_to=2026-03-09`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{ date: string; total: number; skills: Array<{ skill_name: string; count: number }> }>;
      coverage: { metric_scope: string };
    };

    assert.equal(body.coverage.metric_scope, 'all_sessions');

    const march8 = body.data.find((day) => day.date === '2026-03-08');
    assert.ok(march8);
    assert.ok(march8?.skills.some((skill) => skill.skill_name === 'writing-plans'));
    assert.ok(march8?.skills.some((skill) => skill.skill_name === 'first-principles'));

    const march9 = body.data.find((day) => day.date === '2026-03-09');
    assert.ok(march9?.skills.some((skill) => skill.skill_name === 'brainstorming'));
  });

  test('respects agent filter for codex-only skill analytics', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/skills/daily?agent=codex&date_from=2026-03-08&date_to=2026-03-09`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{ date: string; skills: Array<{ skill_name: string }> }>;
    };

    assert.ok(body.data.every((day) => day.skills.every((skill) => skill.skill_name !== 'writing-plans')));
    assert.ok(body.data.some((day) => day.skills.some((skill) => skill.skill_name === 'first-principles')));
    assert.ok(body.data.some((day) => day.skills.some((skill) => skill.skill_name === 'brainstorming')));
  });
});

describe('GET /api/v2/analytics/hour-of-week', () => {
  test('returns a full 7x24 heatmap grid with session/message counts', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/hour-of-week`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{
        day_of_week: number;
        hour_of_day: number;
        session_count: number;
        message_count: number;
      }>;
      coverage: { metric_scope: string };
    };
    assert.equal(body.coverage.metric_scope, 'all_sessions');
    assert.equal(body.data.length, 168);
    const sundayTen = body.data.find(point => point.day_of_week === 6 && point.hour_of_day === 10);
    assert.ok(sundayTen);
    assert.ok((sundayTen?.session_count ?? 0) >= 1);
    assert.ok((sundayTen?.message_count ?? 0) >= 10);
  });
});

describe('GET /api/v2/analytics/top-sessions', () => {
  test('returns the highest-volume sessions in descending order', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/top-sessions?limit=3`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{
        id: string;
        project: string | null;
        agent: string;
        message_count: number;
        user_message_count: number;
      }>;
      coverage: { metric_scope: string };
    };
    assert.equal(body.coverage.metric_scope, 'all_sessions');
    assert.equal(body.data.length, 3);
    assert.equal(body.data[0]?.id, 'api-sess-003');
    assert.equal(body.data[0]?.message_count, 20);
    assert.ok((body.data[0]?.message_count ?? 0) >= (body.data[1]?.message_count ?? 0));
  });
});

describe('GET /api/v2/analytics/velocity', () => {
  test('returns aggregate pace metrics for the filtered session set', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/velocity?project=beta`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      total_sessions: number;
      total_messages: number;
      active_days: number;
      span_days: number;
      sessions_per_active_day: number;
      messages_per_active_day: number;
      sessions_per_calendar_day: number;
      average_messages_per_session: number;
      coverage: { matching_sessions: number; included_sessions: number };
    };
    assert.equal(body.total_sessions, 2);
    assert.equal(body.total_messages, 28);
    assert.equal(body.active_days, 2);
    assert.equal(body.span_days, 3);
    assert.equal(body.coverage.matching_sessions, 2);
    assert.equal(body.coverage.included_sessions, 2);
    assert.ok(body.sessions_per_active_day > 0);
    assert.ok(body.messages_per_active_day > 0);
    assert.ok(body.sessions_per_calendar_day > 0);
    assert.ok(body.average_messages_per_session >= 14);
  });
});

describe('GET /api/v2/analytics/agents', () => {
  test('returns per-agent comparison rows and preserves summary-only agents in all-session metrics', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/agents`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{
        agent: string;
        session_count: number;
        message_count: number;
        average_messages_per_session: number;
        full_fidelity_sessions: number;
        summary_fidelity_sessions: number;
      }>;
      coverage: { metric_scope: string };
    };
    assert.equal(body.coverage.metric_scope, 'all_sessions');
    assert.ok(body.data.some(row => row.agent === 'claude' && row.session_count >= 8));
    assert.ok(body.data.some(
      row => row.agent === 'codex'
        && row.session_count >= 1
        && row.summary_fidelity_sessions >= 1,
    ));
  });
});

describe('GET/POST/DELETE /api/v2/insights', () => {
  test('lists empty insights and exposes generation config status', async () => {
    const res = await fetch(`${baseUrl}/api/v2/insights`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: unknown[];
      generation: {
        default_provider: string;
        providers: Record<string, { configured: boolean; default_model: string }>;
      };
    };

    assert.deepEqual(body.data, []);
    assert.equal(body.generation.default_provider, 'openai');
    assert.equal(body.generation.providers.openai.default_model, 'gpt-5-mini');
    assert.equal(body.generation.providers.anthropic.default_model, 'claude-sonnet-4-5');
    assert.equal(body.generation.providers.gemini.default_model, 'gemini-2.5-flash');
    assert.equal(typeof body.generation.providers.openai.configured, 'boolean');
  });

  test('generates, filters, fetches, and deletes persisted insights', async () => {
    const generateRes = await fetch(`${baseUrl}/api/v2/insights/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'workflow',
        date_from: '2026-03-01',
        date_to: '2026-03-05',
        project: 'alpha',
        agent: 'claude',
        prompt: 'Focus on review bottlenecks.',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      }),
    });
    assert.equal(generateRes.status, 201);
    const generated = await generateRes.json() as {
      id: number;
      kind: string;
      title: string;
      project: string | null;
      agent: string | null;
      prompt: string | null;
      provider: string;
      model: string;
      analytics_summary: { total_sessions: number };
      usage_summary: { total_usage_events: number };
    };
    assert.equal(generated.kind, 'workflow');
    assert.equal(generated.project, 'alpha');
    assert.equal(generated.agent, 'claude');
    assert.equal(generated.prompt, 'Focus on review bottlenecks.');
    assert.equal(generated.provider, 'anthropic');
    assert.equal(generated.model, 'claude-sonnet-4-5');
    assert.ok(generated.analytics_summary.total_sessions >= 1);
    assert.equal(generated.usage_summary.total_usage_events, 1);

    const listRes = await fetch(`${baseUrl}/api/v2/insights?project=alpha&kind=workflow`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json() as {
      data: Array<{ id: number; title: string; content: string }>;
    };
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0]?.id, generated.id);
    assert.match(listBody.data[0]?.content ?? '', /^# workflow generated insight/m);

    const getRes = await fetch(`${baseUrl}/api/v2/insights/${generated.id}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as { id: number; input_snapshot: { analytics_top_sessions: unknown[] } };
    assert.equal(getBody.id, generated.id);
    assert.ok(Array.isArray(getBody.input_snapshot.analytics_top_sessions));

    const deleteRes = await fetch(`${baseUrl}/api/v2/insights/${generated.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteRes.status, 200);
    const deleteBody = await deleteRes.json() as { removed: boolean };
    assert.equal(deleteBody.removed, true);

    const missingRes = await fetch(`${baseUrl}/api/v2/insights/${generated.id}`);
    assert.equal(missingRes.status, 404);
  });

  test('returns generator config error when no API key is available and no test override is installed', async () => {
    setInsightGeneratorForTests(null);
    try {
      const res = await fetch(`${baseUrl}/api/v2/insights/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'overview',
          date_from: '2026-03-01',
          date_to: '2026-03-01',
        }),
      });
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string };
      assert.match(body.error, /OPENAI_API_KEY/);
    } finally {
      setInsightGeneratorForTests(async (params) => ({
        title: `${params.kind} generated insight`,
        content: `# ${params.kind} generated insight\n\nGenerated for ${params.date_from} to ${params.date_to}.`,
        prompt: 'stub prompt',
        provider: params.provider ?? 'openai',
        model: params.model ?? 'gpt-5-mini',
      }));
    }
  });
});

// --- Metadata endpoints ---

describe('GET /api/v2/projects', () => {
  test('returns distinct project names', async () => {
    const res = await fetch(`${baseUrl}/api/v2/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: string[] };
    assert.ok(body.data.includes('alpha'));
    assert.ok(body.data.includes('beta'));
    assert.ok(body.data.includes('gamma'));
  });
});

describe('GET /api/v2/agents', () => {
  test('returns distinct agent types', async () => {
    const res = await fetch(`${baseUrl}/api/v2/agents`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: string[] };
    assert.ok(body.data.includes('claude'));
  });
});

// --- Regression: existing API still works ---

describe('existing API regression', () => {
  test('GET /api/health still works', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'ok');
  });

  test('GET /api/events still works', async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: unknown[] };
    assert.ok(Array.isArray(body.events));
  });
});
