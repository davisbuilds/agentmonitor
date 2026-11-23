import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-otel-usage-precedence-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { getMonitorStats, getUsageSummary } = await import('../src/db/v2-queries.js');

type Row = { id: string; session: string; agent: string; source: string; at: string; cost: number };

function insert(row: Row): void {
  getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, source, client_timestamp)
    VALUES (?, ?, ?, 'llm_response', 'success', 100, 10, ?, ?, ?)
  `).run(row.id, row.session, row.agent, row.cost, row.source, row.at);
}

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  insert({ id: 'cc-import', session: 'cc', agent: 'claude_code', source: 'import', at: '2026-10-27T10:05:00Z', cost: 1 });
  insert({ id: 'cc-otel-covered', session: 'cc', agent: 'claude_code', source: 'otel', at: '2026-10-27T10:04:00Z', cost: 1 });
  insert({ id: 'cc-otel-tail', session: 'cc', agent: 'claude_code', source: 'otel', at: '2026-10-27T10:06:00Z', cost: 0.25 });
  insert({ id: 'cc-live', session: 'cc-live', agent: 'claude_code', source: 'otel', at: '2026-10-27T10:00:00Z', cost: 0.5 });
  insert({ id: 'cdx-import', session: 'cdx', agent: 'codex', source: 'import', at: '2026-10-27T10:05:00Z', cost: 2 });
  insert({ id: 'cdx-otel-covered', session: 'cdx', agent: 'codex', source: 'otel', at: '2026-10-27T10:00:00Z', cost: 2 });
  insert({ id: 'cdx-otel-after', session: 'cdx', agent: 'codex', source: 'otel', at: '2026-10-27T10:10:00Z', cost: 0.125 });
  insert({ id: 'mixed-import', session: 'mixed', agent: 'codex', source: 'import', at: '2026-10-27T11:00:00Z', cost: 4 });
  insert({ id: 'mixed-otel', session: 'mixed', agent: 'claude_code', source: 'otel', at: '2026-10-27T10:00:00Z', cost: 0.0625 });
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('Claude OTEL usage the transcript import covers counts once', () => {
  const stats = getMonitorStats({ agent: 'claude_code' });
  assert.ok(close(stats.total_cost_usd, 1 + 0.25 + 0.5 + 0.0625), `cost ${stats.total_cost_usd}`);
});

test('Usage agrees with the Monitor', () => {
  const summary = getUsageSummary({ agent: 'claude_code' });
  assert.ok(close(summary.total_cost_usd, 1 + 0.25 + 0.5 + 0.0625), `cost ${summary.total_cost_usd}`);
});

test('Codex precedence is unchanged', () => {
  const stats = getMonitorStats({ agent: 'codex' });
  assert.ok(close(stats.total_cost_usd, 2 + 0.125 + 4), `cost ${stats.total_cost_usd}`);
});
