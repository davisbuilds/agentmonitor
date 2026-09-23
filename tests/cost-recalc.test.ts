import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cost-recalc-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { recalculateEventCosts } = await import('../src/pricing/recalc.js');
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');

// claude-sonnet-5 is $2/MTok input, so one million input tokens is exactly $2.
const MODEL = 'claude-sonnet-5';
const TABLE_COST = 2;

function seed(sessionId: string, eventId: string, cost: number | null, source = 'import'): void {
  getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status,
      tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, model, cost_usd,
      source, client_timestamp)
    VALUES (?, ?, 'claude_code', 'llm_response', 'success', 1000000, 0, 0, 0, ?, ?, ?, '2026-09-20T10:00:00Z')
  `).run(eventId, sessionId, MODEL, cost, source);
}

function costOf(eventId: string): number | null {
  return (getDb().prepare('SELECT cost_usd FROM events WHERE event_id = ?').get(eventId) as { cost_usd: number | null }).cost_usd;
}

function summaryCost(sessionId: string): number | undefined {
  return (getDb().prepare('SELECT cost_usd FROM session_trace_summary WHERE session_id = ?')
    .get(sessionId) as { cost_usd: number } | undefined)?.cost_usd;
}

describe('recalculateEventCosts', () => {
  before(() => {
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  });
  beforeEach(() => {
    getDb().exec('DELETE FROM events; DELETE FROM session_trace_summary;');
  });
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('missing-only prices unpriced rows and leaves every existing cost alone', () => {
    seed('s-missing', 'unpriced', null);
    seed('s-missing', 'stale-estimate', 0.5);
    seed('s-missing', 'captured', 1.5, 'benchmark');

    const report = recalculateEventCosts(getDb(), { apply: true, missingOnly: true });

    assert.equal(costOf('unpriced'), TABLE_COST);
    assert.equal(costOf('stale-estimate'), 0.5);
    assert.equal(costOf('captured'), 1.5);
    assert.equal(report.updated, 1);
    assert.equal(report.missing_only, true);
  });

  test('a full recalc still re-derives existing estimates', () => {
    seed('s-full', 'stale-estimate', 0.5);

    const report = recalculateEventCosts(getDb(), { apply: true });

    assert.equal(costOf('stale-estimate'), TABLE_COST);
    assert.equal(report.updated, 1);
  });

  test('applying refreshes the cached per-session summary cost', () => {
    seed('s-summary', 'unpriced', null);
    maintainSessionTraceSummary('s-summary');
    assert.equal(summaryCost('s-summary'), 0);

    const report = recalculateEventCosts(getDb(), { apply: true, missingOnly: true });

    assert.equal(summaryCost('s-summary'), TABLE_COST);
    assert.equal(report.sessions_resummarized, 1);
  });

  test('a dry run reports the change without writing it', () => {
    seed('s-dry', 'unpriced', null);

    const report = recalculateEventCosts(getDb(), { apply: false, missingOnly: true });

    assert.equal(report.updated, 1);
    assert.equal(report.dry_run, true);
    assert.equal(costOf('unpriced'), null);
    assert.equal(report.sessions_resummarized, 0);
  });
});
