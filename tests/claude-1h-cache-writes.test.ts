import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

// Claude transcripts split each request's cache writes into a 5-minute and a
// 1-hour part, and the 1-hour part bills at 2x input rather than 1.25x. These
// follow that split from the transcript through every path that prices a row.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-claude-1h-cache-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent, refreshImportedUsage } = await import('../src/db/queries.js');
const { normalizeIngestEvent } = await import('../src/contracts/event-contract.js');
const { parseClaudeCodeFile } = await import('../src/import/claude-code.js');
const { recalculateEventCosts } = await import('../src/pricing/recalc.js');
const { attributeCostSources } = await import('../src/pricing/cost-provenance.js');

// claude-opus-5: input $5, 5-minute write $6.25, 1-hour write $10 per MTok.
const MODEL = 'claude-opus-5';
const AT = '2026-09-20T10:00:00Z';
const SPLIT_COST = 0.4 * 6.25 + 0.6 * 10;   // 1M cache writes, 600K of them 1-hour
const FLAT_COST = 6.25;                       // the same writes, all at the 5-minute rate

type Row = { cache_write_tokens: number; cache_write_1h_tokens: number; cost_usd: number | null; cost_source: string | null };
const rowOf = (eventId: string) => getDb().prepare(
  'SELECT cache_write_tokens, cache_write_1h_tokens, cost_usd, cost_source FROM events WHERE event_id = ?',
).get(eventId) as Row;
const near = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `got ${actual}, want ${expected}`);

function usageEvent(eventId: string, extra: Record<string, unknown> = {}) {
  const result = normalizeIngestEvent({
    event_id: eventId, session_id: 's-1h', agent_type: 'claude_code', event_type: 'llm_response',
    model: MODEL, tokens_in: 0, tokens_out: 0, cache_write_tokens: 1_000_000, cache_write_1h_tokens: 600_000,
    client_timestamp: AT, source: 'import', ...extra,
  });
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  return result.event;
}

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});
beforeEach(() => {
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  getDb().exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM session_trace_summary;');
});
after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('the ingest contract', () => {
  test('carries the 1-hour part, defaulting to none', () => {
    assert.equal(usageEvent('c1').cache_write_1h_tokens, 600_000);
    const plain = normalizeIngestEvent({ session_id: 's', agent_type: 'claude_code', event_type: 'llm_response' });
    assert.ok(plain.ok);
    assert.equal(plain.event.cache_write_1h_tokens, 0);
  });

  test('rejects a 1-hour part larger than the cache writes', () => {
    const result = normalizeIngestEvent({
      session_id: 's', agent_type: 'claude_code', event_type: 'llm_response',
      cache_write_tokens: 10, cache_write_1h_tokens: 11,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some(error => error.field === 'cache_write_1h_tokens'));
  });
});

describe('the Claude importer', () => {
  test('reads the 1-hour part of a turn once, from its final usage', () => {
    const file = path.join(tempDir, 'session-1h.jsonl');
    const usage = (output: number) => ({
      input_tokens: 3, output_tokens: output, cache_read_input_tokens: 50, cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
    });
    const line = (uuid: string, output: number) => JSON.stringify({
      type: 'assistant', sessionId: 'session-1h', uuid, timestamp: AT,
      message: { id: 'msg-1', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'x' }], usage: usage(output) },
    });
    fs.writeFileSync(file, [line('u-1', 1), line('u-2', 9)].join('\n'));
    const [first, second] = parseClaudeCodeFile(file);
    assert.equal(first.cache_write_tokens, 1_000);
    assert.equal(first.cache_write_1h_tokens, 700);
    assert.equal(second.cache_write_tokens, 0);
    assert.equal(second.cache_write_1h_tokens, 0);
  });

  test('caps a malformed 1-hour part at the cache writes, so the contract keeps the row', () => {
    const file = path.join(tempDir, 'session-bad.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant', sessionId: 'session-bad', uuid: 'u-bad', timestamp: AT,
      message: { id: 'msg-bad', role: 'assistant', model: MODEL, content: [], usage: {
        input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 400 },
      } },
    }));
    const [event] = parseClaudeCodeFile(file);
    assert.equal(event.cache_write_1h_tokens, 100);
  });

  test('a transcript from before the split records no 1-hour part', () => {
    const file = path.join(tempDir, 'session-old.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant', sessionId: 'session-old', uuid: 'u-old', timestamp: AT,
      message: { id: 'msg-old', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500 } },
    }));
    const [event] = parseClaudeCodeFile(file);
    assert.equal(event.cache_write_tokens, 500);
    assert.equal(event.cache_write_1h_tokens, 0);
  });
});

describe('pricing a stored row', () => {
  test('insertEvent stores the 1-hour part and estimates with it, even with no input or output tokens', () => {
    insertEvent(usageEvent('i1'));
    const row = rowOf('i1');
    assert.equal(row.cache_write_1h_tokens, 600_000);
    near(row.cost_usd, SPLIT_COST);
    assert.equal(row.cost_source, 'estimated');
  });

  test('a re-import that learns the split re-estimates the row and keeps a reported cost', () => {
    insertEvent(usageEvent('r-est', { cache_write_1h_tokens: 0 }));
    insertEvent(usageEvent('r-rep', { cache_write_1h_tokens: 0, cost_usd: 1.23 }));
    near(rowOf('r-est').cost_usd, FLAT_COST);

    for (const id of ['r-est', 'r-rep']) {
      assert.notEqual(refreshImportedUsage({ ...usageEvent(id), event_id: id }), null, id);
    }
    assert.equal(rowOf('r-est').cache_write_1h_tokens, 600_000);
    near(rowOf('r-est').cost_usd, SPLIT_COST);
    assert.equal(rowOf('r-rep').cache_write_1h_tokens, 600_000);
    assert.equal(rowOf('r-rep').cost_usd, 1.23);
  });

  test('costs recalc prices the 1-hour part', () => {
    insertEvent(usageEvent('rc'));
    getDb().prepare("UPDATE events SET cost_usd = ? WHERE event_id = 'rc'").run(FLAT_COST);
    recalculateEventCosts(getDb(), { apply: true });
    near(rowOf('rc').cost_usd, SPLIT_COST);
  });

  test('provenance labels a split-priced legacy cost as an estimate', () => {
    insertEvent(usageEvent('pv'));
    getDb().prepare("UPDATE events SET cost_source = NULL WHERE event_id = 'pv'").run();
    attributeCostSources(getDb());
    assert.equal(rowOf('pv').cost_source, 'estimated');
  });
});
