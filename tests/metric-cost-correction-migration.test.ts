import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-metric-cost-migration-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema, runDataMigrations } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insert(eventId: string, tokensIn: number, cost: number, metadata: string): void {
  getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      model, cost_usd, source, metadata)
    VALUES (?, 's-metric', 'claude_code', 'llm_response', 'success', ?, 0, 'claude-sonnet-5', ?, 'otel', ?)
  `).run(eventId, tokensIn, cost, metadata);
}

test('v10 clears the table estimate a Claude token metric row billed on top of the cost metric', () => {
  const db = getDb();
  const metric = JSON.stringify({ _synthetic: true, _source: 'otel_metric' });
  insert('metric-tokens', 1_000_000, 2, metric);
  insert('metric-cost', 0, 1.75, metric);
  insert('log-usage', 1_000_000, 2, '{}');

  db.pragma('user_version = 9');
  runDataMigrations(db);

  const rows = Object.fromEntries((db.prepare('SELECT event_id, cost_usd, cost_source FROM events').all() as Array<{
    event_id: string; cost_usd: number; cost_source: string | null;
  }>).map(row => [row.event_id, [row.cost_usd, row.cost_source]]));
  assert.deepEqual(rows['metric-tokens'], [0, 'reported']);
  assert.deepEqual(rows['metric-cost'], [1.75, null], 'the reported cost itself is untouched');
  assert.deepEqual(rows['log-usage'], [2, null], 'rows outside the metric path are untouched');
  assert.equal(db.pragma('user_version', { simple: true }), 10);
});
