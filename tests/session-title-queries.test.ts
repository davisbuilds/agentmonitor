import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-title-queries-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_TIMEZONE = 'UTC';

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const queries = await import('../src/db/v2-queries.js');
const { getSessionTraceDetail, listSessionTraces } = await import('../src/trace-quality/on-demand.js');
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');
const { insertEvent } = await import('../src/db/queries.js');

const PARENT_UUID = '01a135ab-28ea-70f2-a603-35d75f361637';
const CHILD_UUID = '01a13839-347a-79a2-b7b0-2359f2547f8a';
const PARENT_ROLLOUT = `rollout-2026-10-01T10-00-00-${PARENT_UUID}`;
const CHILD_ROLLOUT = `rollout-2026-10-01T10-05-00-${CHILD_UUID}`;

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  const insert = getDb().prepare(`
    INSERT INTO browsing_sessions (
      id, agent, project, first_message, title, started_at, message_count,
      parent_session_id, relationship_type, integration_mode
    ) VALUES (?, ?, 'app', ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  insert.run('c-parent', 'claude', 'Audit the parser', 'Parser audit', at(1), 4, null, null, 'claude-jsonl');
  insert.run('agent-c1', 'claude', 'You are hunter one', 'hunt one', at(2), 2, 'c-parent', 'subagent', 'claude-jsonl');
  insert.run('agent-c2', 'claude', 'You are hunter two', null, at(3), 2, 'c-parent', 'subagent', 'claude-jsonl');
  insert.run('agent-orphan', 'claude', 'Parent gone', null, at(4), 2, 'missing-parent', 'subagent', 'claude-jsonl');
  insert.run('c-plain', 'claude', 'Plain session', null, at(5), 2, null, null, 'claude-jsonl');
  // A Codex session stored twice: its rollout transcript and its telemetry row.
  insert.run(PARENT_ROLLOUT, 'codex', 'Review the PR', null, at(6), 6, null, 'conversation', 'codex-jsonl');
  insert.run(PARENT_UUID, 'codex', null, null, at(6), 0, null, null, 'codex-import');
  insert.run(CHILD_ROLLOUT, 'codex', null, 'emil pstack', at(7), 3, PARENT_UUID.toUpperCase(), 'subagent', 'codex-jsonl');
  // Its telemetry twin names the same parent; the session still counts once.
  insert.run(CHILD_UUID, 'codex', 'Telemetry prompt', null, at(7), 0, PARENT_UUID, 'subagent', 'codex-otel');
  insert.run('codex-job', 'codex', 'Generate a concise, single-line task title', null, at(8), 2, null, 'internal', 'codex-otel');
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('session lists nest subagents and hide internal jobs', () => {
  test('lists only top-level sessions, with their subagent counts', () => {
    const result = queries.listBrowsingSessions();
    const rows = Object.fromEntries(result.data.map(row => [row.id, row.child_count]));
    assert.deepEqual(rows, {
      'c-parent': 2,
      'agent-orphan': 0,
      'c-plain': 0,
      [PARENT_ROLLOUT]: 1,
    }, 'a subagent whose parent is stored nests under it; one without stays listed');
    assert.equal(result.total, 4);
    assert.equal(result.data.find(row => row.id === 'c-parent')?.title, 'Parser audit');
  });

  test('children are found under either id a Codex parent is stored with', () => {
    assert.deepEqual(queries.getSessionChildren('c-parent').map(row => row.id), ['agent-c1', 'agent-c2']);
    assert.deepEqual(queries.getSessionChildren(PARENT_ROLLOUT).map(row => row.id), [CHILD_ROLLOUT]);
    assert.deepEqual(queries.getSessionChildren(PARENT_UUID).map(row => row.id), [CHILD_ROLLOUT]);
    assert.deepEqual(queries.getSessionChildren('c-plain'), []);
    assert.deepEqual(queries.getSessionChildren('no-such-session'), []);
  });
});

describe('title lookups by event session id', () => {
  test('a Codex UUID resolves to its rollout transcript', () => {
    const titles = queries.lookupSessionTitles(['c-parent', PARENT_UUID, CHILD_UUID.toUpperCase(), 'unknown']);
    assert.deepEqual(titles.get('c-parent'), { title: 'Parser audit', first_message: 'Audit the parser' });
    assert.deepEqual(titles.get(PARENT_UUID), { title: null, first_message: 'Review the PR' });
    assert.deepEqual(titles.get(CHILD_UUID.toUpperCase()), { title: 'emil pstack', first_message: 'Telemetry prompt' },
      'each field comes from whichever stored form has it');
    assert.equal(titles.has('unknown'), false);
    assert.equal(queries.lookupSessionTitles([]).size, 0);
  });

  test('usage top sessions and quality traces carry the title', () => {
    for (const [sessionId, agent] of [['c-parent', 'claude_code'], [PARENT_UUID, 'codex']] as const) {
      insertEvent({
        session_id: sessionId, agent_type: agent, event_type: 'llm_response', status: 'success',
        tokens_in: 100, tokens_out: 10, model: 'claude-opus-4-6', cost_usd: 0.5, metadata: {},
        client_timestamp: '2026-10-01T10:30:00.000Z', source: 'import',
      });
      maintainSessionTraceSummary(sessionId);
    }
    const top = Object.fromEntries(queries.getUsageTopSessions({ date_from: '2026-10-01', date_to: '2026-10-01' })
      .map(row => [row.id, [row.title, row.first_message]]));
    assert.deepEqual(top['c-parent'], ['Parser audit', 'Audit the parser']);
    assert.deepEqual(top[PARENT_UUID], [null, 'Review the PR']);
    const analyticsTop = queries.getAnalyticsTopSessions().find(row => row.id === 'c-parent');
    assert.deepEqual([analyticsTop?.title, analyticsTop?.first_message], ['Parser audit', 'Audit the parser']);

    const traces = listSessionTraces().data;
    const names = Object.fromEntries(traces.map(trace => [trace.session_id, trace.name]));
    assert.equal(names['c-parent'], 'Parser audit');
    assert.equal(names[PARENT_UUID], 'Review the PR');
    const traceId = traces.find(trace => trace.session_id === 'c-parent')!.id;
    assert.equal(getSessionTraceDetail(traceId)?.trace.name, 'Parser audit');
  });
});

describe('search results and pins carry the session title', () => {
  test('both name the session', () => {
    const db = getDb();
    const messageId = Number(db.prepare(`
      INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
      VALUES ('c-parent', 0, 'user', ?, '2026-10-01T10:01:00.000Z', 0, 0, 20)
    `).run(JSON.stringify([{ type: 'text', text: 'zebracorn parser audit' }])).lastInsertRowid);
    const hits = queries.searchMessages({ q: 'zebracorn' }).data;
    assert.equal(hits[0]?.session_title, 'Parser audit');
    assert.equal(queries.searchMessages({ q: 'zebracorn', sort: 'relevance' }).data[0]?.session_title, 'Parser audit');
    assert.equal(queries.pinMessage('c-parent', messageId)?.session_title, 'Parser audit');
    assert.equal(queries.listPinnedMessages()[0]?.session_title, 'Parser audit');
  });
});
