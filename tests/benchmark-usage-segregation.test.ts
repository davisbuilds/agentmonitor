import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import type { getUsageSummary as GetUsageSummary } from '../src/db/v2-queries.js';

let tempDir = '';
let closeDb: (() => void) | null = null;
let getUsageSummary: typeof GetUsageSummary;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-bench-seg-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  initSchema();

  // Guard: never operate against the install DB.
  assert.equal(dbModule.getDb().name, path.join(tempDir, 'test.db'));

  const { insertEvent } = await import('../src/db/queries.js');
  ({ getUsageSummary } = await import('../src/db/v2-queries.js'));

  // A real-activity event.
  insertEvent({
    event_id: 'real-001',
    session_id: 'real-sess',
    agent_type: 'claude_code',
    event_type: 'llm_response',
    status: 'success',
    project: 'alpha',
    model: 'claude-sonnet-4-5-20250929',
    tokens_in: 1000,
    tokens_out: 200,
    cost_usd: 0.5,
    source: 'api',
    metadata: null,
  });

  // A benchmark-import event, same metric shape.
  insertEvent({
    event_id: 'bench-001',
    session_id: 'codex:sometask:minimax-m3:trial1',
    agent_type: 'codex',
    event_type: 'llm_response',
    status: 'success',
    project: 'sometask',
    model: 'minimax-m3',
    tokens_in: 1000,
    tokens_out: 1000,
    cost_usd: 1.5,
    source: 'benchmark',
    metadata: null,
  });
});

after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('benchmark usage segregation', () => {
  test('excludes benchmark events from the default usage summary', () => {
    const summary = getUsageSummary();
    assert.equal(summary.total_usage_events, 1, 'only the real event should count');
    assert.equal(summary.total_cost_usd, 0.5, 'benchmark cost must not sum in');
  });

  test('includes benchmark events when opted in', () => {
    const summary = getUsageSummary({ include_benchmark: true });
    assert.equal(summary.total_usage_events, 2);
    assert.equal(summary.total_cost_usd, 2.0);
  });
});
