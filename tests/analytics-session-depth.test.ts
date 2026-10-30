import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-depth-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_TIMEZONE = 'UTC';
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const queries = await import('../src/db/v2-queries.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

const observable = JSON.stringify({ compactionVisibility: { observable: true } });
const session = db.prepare(`INSERT INTO browsing_sessions
  (id, agent, integration_mode, project, title, started_at, message_count, user_message_count, parent_session_id, relationship_type, skill_context_capabilities_json)
  VALUES (?, ?, ?, 'demo', ?, ?, ?, 1, ?, ?, ?)`);
const compaction = db.prepare(`INSERT INTO session_context_observations (session_id, ordinal, kind, source) VALUES (?, ?, 'compaction', 'test')`);
const compact = (id: string, times: number) => { for (let i = 0; i < times; i++) compaction.run(id, i); };

session.run('c1', 'claude', 'claude-jsonl', 'Backlog sweep', '2026-03-02T10:00:00Z', 100, null, null, observable);
session.run('c2', 'claude', 'claude-jsonl', 'Quick fix', '2026-03-02T12:00:00Z', 10, null, null, observable);
session.run('c3', 'claude', 'claude-jsonl', 'Investigation', '2026-03-03T10:00:00Z', 40, null, null, observable);
// Delegated work compacts on its own clock; depth reads the sessions someone started.
session.run('c-sub', 'claude', 'claude-jsonl', null, '2026-03-02T10:05:00Z', 30, 'c1', 'subagent', observable);
compact('c1', 3);
compact('c3', 1);
compact('c-sub', 2);

const codexId = '01990000-0000-7000-8000-000000000001';
session.run(`rollout-2026-03-03T09-00-00-${codexId}`, 'codex', 'codex-jsonl', 'Cross-repo work', '2026-03-03T09:00:00Z', 200, null, null, observable);
compact(`rollout-2026-03-03T09-00-00-${codexId}`, 5);
// Telemetry only: no transcript, so no way to see its compactions.
session.run('01990000-0000-7000-8000-000000000002', 'codex', 'codex-otel', null, '2026-03-03T11:00:00Z', 0, null, null, null);

const range = { date_from: '2026-03-01', date_to: '2026-03-31' };

test('depth is read per agent, over the started sessions whose transcript can show compactions', () => {
  const byAgent = Object.fromEntries(queries.getAnalyticsSessionDepth(range).agents.map(row => [row.agent, row]));
  assert.deepEqual(Object.keys(byAgent).sort(), ['claude', 'codex']);

  const claude = byAgent.claude;
  assert.deepEqual([claude.sessions, claude.unobservable_sessions, claude.compacted_sessions, claude.compactions], [3, 0, 2, 4]);
  assert.deepEqual(claude.buckets, { none: 1, one: 1, few: 1, many: 0 });
  assert.deepEqual([claude.median_messages, claude.p90_messages], [40, 100]);
  assert.deepEqual(claude.deepest.map(row => [row.id, row.title, row.compactions, row.messages]), [
    ['c1', 'Backlog sweep', 3, 100],
    ['c3', 'Investigation', 1, 40],
  ]);

  const codex = byAgent.codex;
  assert.deepEqual([codex.sessions, codex.unobservable_sessions, codex.compacted_sessions, codex.compactions], [1, 1, 1, 5]);
  assert.deepEqual(codex.buckets, { none: 0, one: 0, few: 0, many: 1 });
});

test('the agent filter keeps one agent', () => {
  assert.deepEqual(queries.getAnalyticsSessionDepth({ ...range, agent: 'codex' }).agents.map(row => row.agent), ['codex']);
});
