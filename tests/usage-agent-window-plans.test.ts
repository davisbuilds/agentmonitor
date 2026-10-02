import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type * as V2Queries from '../src/db/v2-queries.js';

// With an agent filter, the Usage overview's rows and cost total sought an
// agent-led index and looked up every row of that agent's whole history to
// apply the date window: up to 3.5 s each for Codex on a real store. The
// window-led covering usage index answers both inside the index.

let tempDir = '';
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let queries: typeof V2Queries;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-usage-agent-window-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'plans.db');
  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  schema.initSchema();
  queries = await import('../src/db/v2-queries.js');
  assert.equal(getDb().name, path.join(tempDir, 'plans.db'));
  const insert = getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, model, tokens_in, tokens_out, cost_usd, created_at, source)
    VALUES (?, ?, ?, 'llm_response', ?, 10, 5, ?, ?, 'hook')
  `);
  for (let i = 0; i < 60; i++) {
    const agent = ['codex', 'claude_code', 'antigravity'][i % 3];
    insert.run(`evt-${i}`, `s-${i % 6}`, agent, `${agent}-model`, (i + 1) / 100, `2026-${String((Math.floor(i / 3) % 9) + 1).padStart(2, '0')}-15T00:00:00Z`);
  }
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function plan(statement: { sql: string; values: unknown[] }): string {
  return (getDb().prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.values) as Array<{ detail: string }>)
    .map(row => row.detail)
    .join(' | ');
}

const window = { date_from: '2026-08-01', date_to: '2026-09-30' };

for (const agent of ['codex', 'claude_code']) {
  test(`an agent filter with a date window reads usage rows and cost inside the window index (${agent})`, () => {
    for (const statement of [queries.usageRowsStatement({ agent, ...window }), queries.usageCostTotalStatement({ agent, ...window })]) {
      const detail = plan(statement);
      assert.match(detail, /SEARCH e USING COVERING INDEX idx_events_usage_covering \(<expr>>\? AND <expr><\?\)/, detail);
    }
  });
}

test('an agent filter without a window keeps the agent index, which suits a rare agent', () => {
  for (const statement of [queries.usageRowsStatement({ agent: 'antigravity' }), queries.usageCostTotalStatement({ agent: 'antigravity' })]) {
    const detail = plan(statement);
    assert.match(detail, /USING (COVERING )?INDEX idx_events_\w+ \(agent_type=\?/, detail);
  }
});

test('the window-led plan returns the same usage as the agent-led one', () => {
  for (const agent of ['codex', 'claude_code', 'antigravity']) {
    for (const params of [{ agent, ...window }, { agent, date_from: '2026-01-01' }, { agent, date_to: '2026-03-01' }]) {
      const rows = queries.usageRowsStatement(params);
      const cost = queries.usageCostTotalStatement(params);
      const agentLed = (sql: string) => sql.replace('+e.agent_type = ?', 'e.agent_type = ?');
      assert.deepEqual(getDb().prepare(rows.sql).all(...rows.values), getDb().prepare(agentLed(rows.sql)).all(...rows.values), JSON.stringify(params));
      assert.deepEqual(getDb().prepare(cost.sql).get(...cost.values), getDb().prepare(agentLed(cost.sql)).get(...cost.values), JSON.stringify(params));
      assert.ok((getDb().prepare(rows.sql).all(...rows.values) as unknown[]).length > 0, `fixture has rows for ${JSON.stringify(params)}`);
    }
  }
});

test('the top sessions\' event count seeks each session\'s window inside one index', () => {
  // It counts every event of the costliest sessions in the window; through the
  // session_id index alone that meant a row lookup per event (3.7 s for ten
  // large sessions on a real store, against 18 ms inside a covering index).
  for (const params of [window, { ...window, include_benchmark: true }]) {
    const detail = plan(queries.usageSessionEventCountStatement(['s-0', 's-1'], params));
    assert.match(detail, /SEARCH e USING COVERING INDEX idx_events_session_window \(session_id=\? AND <expr>>\? AND <expr><\?\)/, `${JSON.stringify(params)}: ${detail}`);
  }
});
