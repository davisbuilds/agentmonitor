import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-usage-prior-costs-'));
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
const usage = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, project, model, tokens_in, cost_usd, client_timestamp, source)
  VALUES (?, ?, 'llm_response', ?, ?, 10, ?, ?, 'import')`);
// The range is 03/02 to 03/04; the period before is 02/27 to 03/01.
usage.run('s1', 'claude_code', 'alpha', 'claude-opus-5-5', 3, '2026-03-02T10:00:00Z');
usage.run('s2', 'codex', 'beta', 'gpt-6-astra', 1, '2026-03-03T10:00:00Z');
usage.run('p1', 'claude_code', 'alpha', 'claude-opus-5-5', 2, '2026-02-28T10:00:00Z');
usage.run('p2', 'claude_code', 'gamma', 'claude-opus-5-5', 5, '2026-03-01T10:00:00Z');
// Outside both periods.
usage.run('old', 'codex', 'beta', 'gpt-6-astra', 7, '2026-02-20T10:00:00Z');

test('each breakdown carries its rows\' cost in the period before', () => {
  const { prior_costs: prior } = queries.getUsageOverview({ date_from: '2026-03-02', date_to: '2026-03-04' });
  assert.deepEqual(prior.range, { from: '2026-02-27', to: '2026-03-01' });
  assert.deepEqual(prior.projects, { alpha: 2, gamma: 5 });
  assert.deepEqual(prior.agents, { claude_code: 7 });
  assert.deepEqual(prior.models, { 'claude-opus-5-5': 7 });
  assert.deepEqual(Object.values(prior.tiers), [7]);
});

test('the period before honors the page filters', () => {
  const { prior_costs: prior } = queries.getUsageOverview({ date_from: '2026-03-02', date_to: '2026-03-04', project: 'alpha' });
  assert.deepEqual(prior.projects, { alpha: 2 });
});

test('without a range there is no period before', () => {
  assert.deepEqual(queries.getUsageOverview().prior_costs, { range: null, projects: {}, models: {}, tiers: {}, agents: {} });
});
