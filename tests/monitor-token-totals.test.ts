import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-monitor-token-totals-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { getStats, monitorUsageSql } = await import('../src/db/queries.js');
const { excludeBenchmarkUsageCondition, excludeOverlappingCodexOtelUsageCondition, usageMetricPresenceCondition } = await import('../src/db/usage-reconciliation.js');
const { getMonitorStats } = await import('../src/db/v2-queries.js');

type Row = {
  id: string; session: string; agent: string; source: string; at: string;
  tin: number; tout: number; cr?: number; cw?: number; cost?: number;
};

function insert(row: Row): void {
  getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cost_usd, source, client_timestamp)
    VALUES (?, ?, ?, 'llm_response', 'success', ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.session, row.agent, row.tin, row.tout, row.cr ?? 0, row.cw ?? 0, row.cost ?? null, row.source, row.at);
}

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  // Codex: an imported request, an OTEL row the import already covers (excluded),
  // and an OTEL row after the last import (counted).
  insert({ id: 'cdx-import', session: 'cdx', agent: 'codex', source: 'import', at: '2026-07-01T10:05:00Z', tin: 100, tout: 10, cr: 1000, cost: 0.5 });
  insert({ id: 'cdx-otel-covered', session: 'cdx', agent: 'codex', source: 'otel', at: '2026-07-01T10:00:00Z', tin: 50, tout: 5, cr: 500, cost: 0.2 });
  insert({ id: 'cdx-otel-after', session: 'cdx', agent: 'codex', source: 'otel', at: '2026-07-01T10:10:00Z', tin: 7, tout: 1, cr: 70, cost: 0.01 });
  // Claude: cache reads and writes dominate.
  insert({ id: 'cc-import', session: 'cc', agent: 'claude_code', source: 'import', at: '2026-07-01T11:00:00Z', tin: 3, tout: 40, cr: 9000, cw: 800, cost: 1.2 });
  // A benchmark row never reaches the Monitor.
  insert({ id: 'bench', session: 'bench', agent: 'codex', source: 'benchmark', at: '2026-07-01T12:00:00Z', tin: 999, tout: 99, cr: 99_999, cw: 9_999, cost: 9 });
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('Monitor stats total every token bucket, per agent, with the Monitor\'s exclusions', () => {
  const stats = getMonitorStats();
  assert.equal(stats.total_tokens_in, 110);
  assert.equal(stats.total_tokens_out, 51);
  assert.equal(stats.total_cache_read_tokens, 10_070);
  assert.equal(stats.total_cache_write_tokens, 800);
  assert.ok(close(stats.total_cost_usd, 1.71), `cost ${stats.total_cost_usd}`);

  assert.deepEqual(Object.keys(stats.usage_by_agent).sort(), ['claude_code', 'codex']);
  const codex = stats.usage_by_agent.codex;
  assert.deepEqual(
    [codex.tokens_in, codex.tokens_out, codex.cache_read_tokens, codex.cache_write_tokens],
    [107, 11, 1_070, 0],
  );
  assert.ok(close(codex.cost_usd, 0.51));
  const claude = stats.usage_by_agent.claude_code;
  assert.deepEqual(
    [claude.tokens_in, claude.tokens_out, claude.cache_read_tokens, claude.cache_write_tokens],
    [3, 40, 9_000, 800],
  );
});

test('the per-agent split adds up to the totals', () => {
  const stats = getMonitorStats();
  const agents = Object.values(stats.usage_by_agent);
  const sum = (pick: (a: typeof agents[number]) => number) => agents.reduce((n, a) => n + pick(a), 0);
  assert.equal(sum(a => a.tokens_in), stats.total_tokens_in);
  assert.equal(sum(a => a.tokens_out), stats.total_tokens_out);
  assert.equal(sum(a => a.cache_read_tokens), stats.total_cache_read_tokens);
  assert.equal(sum(a => a.cache_write_tokens), stats.total_cache_write_tokens);
  assert.ok(close(sum(a => a.cost_usd), stats.total_cost_usd));
});

test('an agent filter narrows the split and the totals together, with the same exclusions', () => {
  // An unfiltered read reuses the broadcast snapshot; a filtered one runs its own query.
  const stats = getMonitorStats({ agent: 'codex' });
  assert.deepEqual(Object.keys(stats.usage_by_agent), ['codex']);
  assert.equal(stats.total_tokens_in, 107, 'the covered OTEL row and the benchmark row stay out');
  assert.equal(stats.total_cache_read_tokens, 1_070);
  assert.equal(stats.total_cache_write_tokens, 0);
});

test('the SSE stats broadcast carries the same usage as the REST read', () => {
  // The broadcast replaces the bar's stats every few seconds, so a field the
  // REST read has and the broadcast lacks would vanish from the display.
  const keys = ['total_tokens_in', 'total_tokens_out', 'total_cache_read_tokens', 'total_cache_write_tokens', 'total_cost_usd', 'usage_by_agent'] as const;
  for (const agent of [undefined, 'codex']) {
    const rest = getMonitorStats(agent ? { agent } : {});
    const broadcast = getStats(agent ? { agentType: agent } : undefined);
    for (const key of keys) assert.deepEqual(broadcast[key], rest[key], `${agent ?? 'all'}: ${key}`);
  }
});

test('the usage sum scans the covering usage index, not a row-by-row agent index', () => {
  // Grouping by agent_type let SQLite pick an agent_type index that does not
  // cover the token columns: 4.4s against 18ms on a real store.
  const where = `WHERE ${excludeBenchmarkUsageCondition('e')} AND ${usageMetricPresenceCondition('e')} AND ${excludeOverlappingCodexOtelUsageCondition('e')}`;
  const plan = (getDb().prepare(`EXPLAIN QUERY PLAN ${monitorUsageSql(where)}`).all() as Array<{ detail: string }>)
    .map(row => row.detail);
  assert.ok(plan.some(detail => detail.includes('COVERING INDEX idx_events_usage_covering')), plan.join(' | '));
});
