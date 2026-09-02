import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import type Database from 'better-sqlite3';
import type { importBenchmarkResults as ImportBenchmarkResults } from '../src/import/benchmark.js';
import type { getEvents as GetEvents } from '../src/db/queries.js';

let tempDir = '';
let closeDb: (() => void) | null = null;
let importBenchmarkResults: typeof ImportBenchmarkResults;
let getEvents: typeof GetEvents;
let getDb: () => Database.Database;

function writeResults(rows: object[]): string {
  const file = path.join(tempDir, `results-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const minimaxRow = {
  run_id: 'codex:task-a:minimax-m3:trial1',
  harness: 'codex',
  model: 'minimax-m3',
  task: 'task-a',
  trial: 1,
  ts_iso: '2026-08-29T14:18:20',
  success: true,
  completed: true,
  wall_time_s: 12.5,
  turns: 3,
  tokens_input_uncached: 1_000_000,
  tokens_output: 1_000_000,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  tokens_reasoning: 200,
  token_basis: 'vendor_split',
  cost_usd: null,
};

// codex daily-driver comparator with a reasoning-effort suffix on the model.
const codexRow = {
  run_id: 'codex:task-a:gpt-5.6-terra-xhigh:trial1',
  harness: 'codex',
  model: 'gpt-5.6-terra-xhigh',
  task: 'task-a',
  trial: 1,
  ts_iso: '2026-08-29T14:20:00',
  success: true,
  tokens_input_uncached: 100_000,
  tokens_output: 1_000,
};

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-bench-import-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  initSchema();
  assert.equal(dbModule.getDb().name, path.join(tempDir, 'test.db'));

  ({ importBenchmarkResults } = await import('../src/import/benchmark.js'));
  ({ getEvents } = await import('../src/db/queries.js'));
});

after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('importBenchmarkResults', () => {
  test('imports rows as segregated benchmark events with derived cost', () => {
    const file = writeResults([minimaxRow, codexRow]);
    const result = importBenchmarkResults(file);

    assert.equal(result.rowsRead, 2);
    assert.equal(result.eventsImported, 2);
    assert.equal(result.duplicates, 0);
    assert.deepEqual(result.unpricedModels, []);

    const events = getEvents({ source: 'benchmark' }).events;
    assert.equal(events.length, 2);

    const minimax = events.find(e => e.model === 'minimax-m3');
    assert.ok(minimax);
    assert.equal(minimax.source, 'benchmark');
    assert.equal(minimax.session_id, 'codex:task-a:minimax-m3:trial1');
    // 1M input * 0.30/MTok + 1M output * 1.20/MTok
    assert.ok(Math.abs((minimax.cost_usd ?? 0) - 1.5) < 1e-9, `got ${minimax.cost_usd}`);

    // Effort-suffix stripped so the codex base model resolves to a real price.
    const codex = events.find(e => e.model === 'gpt-5.6-terra-xhigh');
    assert.ok(codex);
    assert.ok((codex.cost_usd ?? 0) > 0, 'effort-suffixed codex model should be priced');
  });

  test('is idempotent — re-importing the same file inserts nothing', () => {
    const file = writeResults([minimaxRow]);
    importBenchmarkResults(file);
    const second = importBenchmarkResults(file);
    assert.equal(second.eventsImported, 0);
    assert.equal(second.duplicates, 1);
  });

  test('reports unpriced models loudly and skips malformed rows', () => {
    const file = writeResults([
      { run_id: 'codex:task-b:mystery-model:trial1', harness: 'codex', model: 'mystery-model', tokens_input_uncached: 500, tokens_output: 100 },
      { run_id: 'no-model', harness: 'codex' }, // missing model -> skipped
    ]);
    const result = importBenchmarkResults(file);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.unpricedModels, ['mystery-model']);
  });

  test('dry-run counts without writing', () => {
    const file = writeResults([{ ...minimaxRow, run_id: 'codex:task-c:minimax-m3:trial1' }]);
    const before = getEvents({ source: 'benchmark' }).events.length;
    const result = importBenchmarkResults(file, { dryRun: true });
    assert.equal(result.eventsImported, 1);
    assert.equal(getEvents({ source: 'benchmark' }).events.length, before);
  });

  test('does not project codex benchmark cells into the live session browser', () => {
    const runId = 'codex:task-live:minimax-m3:trial1';
    const file = writeResults([{ ...minimaxRow, run_id: runId }]);
    importBenchmarkResults(file);

    const browsing = getDb()
      .prepare('SELECT COUNT(*) AS n FROM browsing_sessions WHERE id = ?')
      .get(runId) as { n: number };
    assert.equal(browsing.n, 0, 'codex benchmark row must not create a browsing_sessions projection');
  });

  test('re-import backfills a benchmark cost that was null at first import', () => {
    const runId = 'codex:task-backfill:mystery-model:trial1';
    // First import: model unpriced and the row carries no cost -> stored as null.
    const first = writeResults([
      { run_id: runId, harness: 'codex', model: 'mystery-model', tokens_input_uncached: 500, tokens_output: 100, cost_usd: null },
    ]);
    importBenchmarkResults(first);
    const stored = getEvents({ source: 'benchmark' }).events.find(e => e.session_id === runId);
    assert.ok(stored);
    assert.equal(stored.cost_usd, null, 'cost is null while the model is unpriced');

    // Re-run once a cost resolves (rates added / row now carries cost_usd).
    const second = writeResults([
      { run_id: runId, harness: 'codex', model: 'mystery-model', tokens_input_uncached: 500, tokens_output: 100, cost_usd: 0.42 },
    ]);
    const result = importBenchmarkResults(second);
    assert.equal(result.duplicates, 1, 'the run_id already exists');
    assert.equal(result.costsBackfilled, 1, 'the previously-null cost is backfilled');

    const refreshed = getEvents({ source: 'benchmark' }).events.find(e => e.session_id === runId);
    assert.ok(Math.abs((refreshed?.cost_usd ?? 0) - 0.42) < 1e-9, `expected backfilled 0.42, got ${refreshed?.cost_usd}`);
  });

  test('skips non-object JSON rows instead of aborting the whole import', () => {
    const goodRow = { ...minimaxRow, run_id: 'codex:task-good:minimax-m3:trial1' };
    const file = path.join(tempDir, 'nonobject.jsonl');
    // `null`, an array, and a bare number are all valid JSON but not benchmark rows.
    fs.writeFileSync(file, ['null', '[1,2,3]', '42', JSON.stringify(goodRow)].join('\n') + '\n');
    const result = importBenchmarkResults(file);
    assert.equal(result.rowsRead, 4);
    assert.equal(result.skipped, 3, 'the three non-object rows are skipped');
    assert.equal(result.eventsImported, 1, 'the valid row still imports');
  });
});
