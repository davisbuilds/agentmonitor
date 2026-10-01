import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type * as V2Queries from '../src/db/v2-queries.js';
import type * as Ledger from '../src/skills/invocation-ledger.js';

// An agent filter let SQLite seek the low-cardinality agent_type index and look
// up every matching row: on a real store the Codex-filtered Monitor stats took
// 16 s and its event page about 6 s. These pin the plans that avoid it.

let tempDir = '';
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let queries: typeof V2Queries;
let ledger: typeof Ledger;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agent-filter-plans-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'plans.db');
  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  schema.initSchema();
  queries = await import('../src/db/v2-queries.js');
  ledger = await import('../src/skills/invocation-ledger.js');
  assert.equal(getDb().name, path.join(tempDir, 'plans.db'));

  const insert = getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, tool_name, model, tokens_in, tokens_out, cost_usd, created_at, source)
    VALUES (?, ?, ?, 'tool_use', ?, ?, ?, 1, 0.01, ?, 'hook')
  `);
  for (let i = 0; i < 40; i++) {
    const codex = i % 2 === 0;
    insert.run(`evt-${i}`, `s-${i % 4}`, codex ? 'codex' : 'claude_code', codex ? 'exec_command' : 'Edit',
      codex ? 'gpt-5.5' : 'claude-opus-5-5', codex ? 3 : 5, `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`);
  }
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function plan(sql: string, values: unknown[]): string {
  return (getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>)
    .map(row => row.detail)
    .join(' | ');
}

for (const agent of ['codex', 'claude_code']) {
  test(`agent-filtered Monitor stats read events through covering indexes (${agent})`, () => {
    const { statements } = queries.monitorStatsStatements({ agent });
    for (const statement of statements.filter(entry => entry.sql.includes('FROM events'))) {
      const detail = plan(statement.sql, statement.values);
      assert.doesNotMatch(detail, /idx_events_agent_type\b/, `${statement.name}: ${detail}`);
      assert.match(detail, /(SEARCH|SCAN) e USING COVERING INDEX/, `${statement.name}: ${detail}`);
    }
    const usage = statements.find(entry => entry.name === 'usage')!;
    assert.match(plan(usage.sql, usage.values), /COVERING INDEX idx_events_usage_covering/);
  });

  test(`the agent-filtered event page is read in order, not sorted (${agent})`, () => {
    const { count, page } = queries.monitorEventsStatements({ agent });
    const pageDetail = plan(page.sql, page.values);
    assert.doesNotMatch(pageDetail, /TEMP B-TREE FOR ORDER BY/, pageDetail);
    assert.match(pageDetail, /idx_events_agent_created_order/, pageDetail);
    assert.match(plan(count.sql, count.values), /COVERING INDEX/);
  });
}

test('the agent filter still selects only that agent', () => {
  const stats = queries.getMonitorStats({ agent: 'codex' });
  assert.equal(stats.total_events, 20);
  assert.equal(stats.total_tokens_in, 60);
  assert.deepEqual(stats.tool_breakdown, { exec_command: 20 });
  assert.deepEqual(stats.model_breakdown, { 'gpt-5.5': 20 });
  assert.deepEqual(Object.keys(stats.usage_by_agent), ['codex']);
  const feed = queries.listMonitorEvents({ agent: 'claude_code', limit: 5 });
  assert.equal(feed.total, 20);
  assert.deepEqual(feed.events.map(event => event.agent_type), Array(5).fill('claude_code'));
  assert.deepEqual(feed.events.map(event => event.created_at), [...feed.events.map(event => event.created_at)].sort().reverse());
});

test('the windowed Codex skill-event read seeks exec tool calls, not every Codex event', () => {
  // The same agent_type-only seek made skill health and daily read all Codex
  // events (about 3 s on a real store) to find a few SKILL.md commands.
  const statement = ledger.codexSkillEventStatement({ date_from: '2026-09-01', date_to: '2026-09-30' });
  const detail = plan(statement.sql, statement.values);
  assert.doesNotMatch(detail, /idx_events_agent_type\b/, detail);
  assert.match(detail, /idx_events_agent_dims \(agent_type=\? AND tool_name=\?\)/, detail);
});

