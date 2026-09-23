import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-daily-'));
let server: Server;
let base: string;
let closeDb: () => void;
before(async () => {
  process.env.AGENTMONITOR_DB_PATH = path.join(dir, 'test.db');
  // These fixtures encode America/New_York days and DST boundaries, the zone
  // this read was built against. Pin it so the suite reads the same on any host.
  process.env.AGENTMONITOR_TIMEZONE = 'America/New_York';
  const connection = await import('../src/db/connection.js');
  closeDb = connection.closeDb;
  (await import('../src/db/schema.js')).initSchema();
  const db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  // Simulate the preceding schema: a read upgrade must install both indexes.
  db.exec('DROP INDEX idx_events_daily_activity; DROP INDEX idx_messages_daily_activity; PRAGMA user_version=8');
  (await import('../src/db/schema.js')).ensureSchemaForRead();
  assert.equal(db.pragma('user_version', { simple: true }), 10);
  assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('idx_events_daily_activity','idx_messages_daily_activity')").get() as { n: number }).n, 2);
  const browser = db.prepare(`INSERT INTO browsing_sessions
    (id,agent,integration_mode,relationship_type,started_at)
    VALUES (?, 'codex','codex-jsonl',?,'2026-09-01T10:00:00Z')`);
  const message = db.prepare(`INSERT INTO messages(session_id,ordinal,role,content,timestamp)
    VALUES (?,?,'user','private fixture',?)`);
  browser.run('root', 'conversation');
  message.run('root', 0, '2026-09-15T12:00:00Z');
  message.run('root', 1, '2026-09-15T13:00:00Z');
  message.run('root', 2, '2026-09-16T03:59:59Z');
  message.run('root', 3, '2026-09-16T04:00:00Z');
  for (let i = 0; i < 5; i++) {
    browser.run(`child-${i}`, 'subagent');
    message.run(`child-${i}`, 0, '2026-09-15T15:00:00Z');
  }
  for (let i = 0; i < 14; i++) {
    browser.run(`internal-${i}`, 'internal');
    message.run(`internal-${i}`, 0, '2026-09-15T16:00:00Z');
  }
  browser.run('unknown', null);
  message.run('unknown', 0, '2026-09-15T16:00:00Z');
  browser.run('startup-only', 'conversation'); // Creation alone is not activity.
  browser.run('startup-with-usage', 'conversation');
  db.prepare(`INSERT INTO events(session_id,agent_type,event_type,source,tokens_in,client_timestamp)
    VALUES ('projection:startup-with-usage','codex','llm_response','otel',10,'2026-09-15T12:00:00Z')`).run();
  // Both projections contain work; a representative-only scan loses day two.
  const uuid = '11111111-2222-4333-8444-555555555555';
  browser.run(`rollout-2026-09-01T10-00-00-${uuid}`, 'conversation');
  message.run(`rollout-2026-09-01T10-00-00-${uuid}`, 0, '2026-09-13T12:00:00Z');
  db.prepare(`INSERT INTO browsing_sessions(id,agent,integration_mode,started_at)
    VALUES (?,'codex','codex-import','2026-09-01T10:00:00Z')`).run(uuid);
  message.run(uuid, 0, '2026-09-14T12:00:00Z');
  // Fork history remains browsable, but before-creation evidence is not work.
  db.prepare("UPDATE browsing_sessions SET started_at='2026-09-15T14:00:00Z' WHERE id='child-0'").run();
  message.run('child-0', 1, '2026-09-14T12:00:00Z');
  message.run('unknown', 1, '2026-09-13 12:00:00'); // Explicitly unresolved, not guessed UTC.
  db.prepare(`INSERT INTO events(session_id,agent_type,event_type,source,client_timestamp)
    VALUES ('future-thread','future-harness','user_prompt','api','2026-09-12T12:00:00Z')`).run();
  db.prepare(`INSERT INTO browsing_sessions(id,agent,integration_mode,started_at)
    VALUES ('dst','claude','claude-jsonl','2025-01-01T12:00:00Z')`).run();
  ['2025-03-09T04:59:59Z', '2025-03-09T05:00:00Z',
    '2025-11-02T01:30:00-04:00', '2025-11-02T01:30:00-05:00'].forEach((stamp, i) => message.run('dst', i, stamp));
  server = (await import('../src/app.js')).createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close(); await once(server, 'close'); closeDb();
  fs.rmSync(dir, { recursive: true });
});
test('daily work counts continued conversations once, separates children and excludes housekeeping', async () => {
  const response = await fetch(`${base}/api/v2/activity/daily?since=2026-09-15&until=2026-09-16`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema_version, 'daily-conversations.v1');
  assert.equal(body.unresolved_timestamps, 1);
  assert.deepEqual(body.data, [
    { date: '2026-09-15', agent: 'codex', classification: 'conversation', count: 1 },
    { date: '2026-09-15', agent: 'codex', classification: 'delegated', count: 5 },
    { date: '2026-09-15', agent: 'codex', classification: 'internal', count: 14 },
    { date: '2026-09-15', agent: 'codex', classification: 'unclassified', count: 2 },
    { date: '2026-09-16', agent: 'codex', classification: 'conversation', count: 1 },
  ]);
  assert.ok(!JSON.stringify(body).includes('private fixture'));
});
test('all recognized projections contribute dated work without inheriting earlier fork activity', async () => {
  const body = await (await fetch(`${base}/api/v2/activity/daily?since=2026-09-13&until=2026-09-14`)).json();
  assert.deepEqual(body.data, [
    { date: '2026-09-13', agent: 'codex', classification: 'conversation', count: 1 },
    { date: '2026-09-14', agent: 'codex', classification: 'conversation', count: 1 },
  ]);
});
test('daily windows reject missing, malformed, extra and oversized parameters', async () => {
  for (const query of ['', 'since=2026-02-30&until=2026-03-01',
    'since=2026-01-01&until=2026-03-01', 'since=2026-09-15&until=2026-09-15&timezone=UTC']) {
    assert.equal((await fetch(`${base}/api/v2/activity/daily?${query}`)).status, 400);
  }
});
test('DST boundaries and future harness labels retain explicit date and classification semantics', async () => {
  const read = async (since: string, until = since) => (await (await fetch(`${base}/api/v2/activity/daily?since=${since}&until=${until}`)).json()).data;
  assert.deepEqual(await read('2025-03-08', '2025-03-09'), [
    { date: '2025-03-08', agent: 'claude', classification: 'conversation', count: 1 },
    { date: '2025-03-09', agent: 'claude', classification: 'conversation', count: 1 },
  ]);
  assert.deepEqual(await read('2025-11-02'), [
    { date: '2025-11-02', agent: 'claude', classification: 'conversation', count: 1 },
  ]);
  assert.deepEqual(await read('2026-09-12'), [
    { date: '2026-09-12', agent: 'unknown', classification: 'unclassified', count: 1 },
  ]);
});

test('daily evidence uses timestamp index seeks rather than scanning historical content', async () => {
  const { getDb } = await import('../src/db/connection.js');
  const { getDailyConversationActivity } = await import('../src/db/v2-queries.js');
  const db = getDb(), prepare = db.prepare;
  let plan: string[] = [];
  // Observe the actual statement and bound values; do not substitute query results.
  Object.defineProperty(db, 'prepare', { configurable: true, value: (sql: string) => {
    const statement = prepare.call(db, sql);
    if (sql.includes('all_browser AS')) {
      const iterate = statement.iterate.bind(statement);
      Object.defineProperty(statement, 'iterate', { value: (...args: unknown[]) => {
        plan = (prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(r => r.detail);
        return iterate(...args);
      } });
    }
    return statement;
  } });
  try { getDailyConversationActivity('2026-09-15', '2026-09-15'); }
  finally { Object.defineProperty(db, 'prepare', { value: prepare, configurable: true }); }
  assert.ok(plan.some(p => /SEARCH events.*idx_events_daily_activity.*<expr>>\? AND <expr><\?/.test(p)), plan.join('\n'));
  assert.ok(plan.some(p => /SEARCH m.*idx_messages_daily_activity.*<expr>>\? AND <expr><\?/.test(p)), plan.join('\n'));
  assert.ok(!plan.some(p => /MERGE \(UNION\)|UNION USING TEMP B-TREE/.test(p)), 'cap must not wait for an all-history distinct set');
});

test('dense historical evidence is excluded from empty windows and capped without a partial result', async () => {
  const { getDb } = await import('../src/db/connection.js');
  const db = getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  const q = await import('../src/db/v2-queries.js');
  assert.equal(q.DAILY_ACTIVITY_EVIDENCE_LIMIT, 200_000);
  // Exceed a lowered cap rather than the real one: 200k inserts block this
  // in-process server past its keep-alive timeout and reset the next fetch.
  const limit = 100;
  q.setDailyActivityEvidenceLimitForTests(limit);
  try {
    const insert = db.prepare(`INSERT INTO events(session_id,agent_type,event_type,source,client_timestamp)
      VALUES ('dense-history','codex','user_prompt','api','2024-01-01T12:00:00Z')`);
    db.transaction(() => { for (let i = 0; i < limit + 5; i++) insert.run(); })();
    const empty = await fetch(`${base}/api/v2/activity/daily?since=2024-02-01&until=2024-02-01`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data, []);
    const dense = await fetch(`${base}/api/v2/activity/daily?since=2024-01-01&until=2024-01-01`);
    assert.equal(dense.status, 503);
    assert.equal((await dense.json()).code, 'activity_unavailable');
  } finally {
    q.setDailyActivityEvidenceLimitForTests(null);
  }
});
