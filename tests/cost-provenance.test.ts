import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cost-provenance-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { normalizeIngestEvent } = await import('../src/contracts/event-contract.js');
const { recalculateEventCosts } = await import('../src/pricing/recalc.js');
const { attributeCostSources } = await import('../src/pricing/cost-provenance.js');

// claude-sonnet-5 is $2/MTok input, so one million input tokens is exactly $2.
const MODEL = 'claude-sonnet-5';
const TABLE_COST = 2;
const AT = '2026-09-20T10:00:00Z';

type Row = { cost_usd: number | null; cost_source: string | null };

function rowOf(eventId: string): Row {
  return getDb().prepare('SELECT cost_usd, cost_source FROM events WHERE event_id = ?').get(eventId) as Row;
}

function usage(eventId: string, extra: Record<string, unknown> = {}) {
  return {
    event_id: eventId, session_id: 's-prov', agent_type: 'claude_code', event_type: 'llm_response' as const,
    status: 'success' as const, tokens_in: 1_000_000, tokens_out: 0, model: MODEL, client_timestamp: AT,
    metadata: {}, ...extra,
  };
}

/** A row as written before provenance existed: a cost and no label. */
function legacy(eventId: string, cost: number | null, fields: { source?: string; agent?: string; metadata?: string } = {}): void {
  getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      model, cost_usd, source, client_timestamp, metadata)
    VALUES (?, 's-legacy', ?, 'llm_response', 'success', 1000000, 0, ?, ?, ?, ?, ?)
  `).run(eventId, fields.agent ?? 'claude_code', MODEL, cost, fields.source ?? 'api', AT, fields.metadata ?? '{}');
}

describe('cost provenance', () => {
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

  describe('new rows are labelled when written', () => {
    test('a cost the producer sends is reported', () => {
      insertEvent(usage('sent', { cost_usd: 1.23 }));
      assert.deepEqual(rowOf('sent'), { cost_usd: 1.23, cost_source: 'reported' });
    });

    test('a cost priced from the tables is estimated', () => {
      insertEvent(usage('priced'));
      assert.deepEqual(rowOf('priced'), { cost_usd: TABLE_COST, cost_source: 'estimated' });
    });

    test('an importer that priced the row itself says so', () => {
      insertEvent(usage('imported', { cost_usd: TABLE_COST, cost_source: 'estimated', source: 'import' }));
      assert.equal(rowOf('imported').cost_source, 'estimated');
    });

    test('a row with no cost has no label', () => {
      insertEvent(usage('unpriced', { model: 'no-such-model' }));
      assert.deepEqual(rowOf('unpriced'), { cost_usd: null, cost_source: null });
    });

    test('an API client cannot label its own cost an estimate', () => {
      const result = normalizeIngestEvent({ ...usage('client'), cost_usd: 9, cost_source: 'estimated' });
      assert.ok(result.ok);
      insertEvent(result.event);
      assert.equal(rowOf('client').cost_source, 'reported');
    });
  });

  describe('recalc', () => {
    test('a full recalc re-derives estimates and never touches a reported cost', () => {
      insertEvent(usage('reported', { cost_usd: 5 }));
      insertEvent(usage('stale', { cost_usd: 0.5, cost_source: 'estimated' }));

      const report = recalculateEventCosts(getDb(), { apply: true });

      assert.equal(rowOf('reported').cost_usd, 5);
      assert.deepEqual(rowOf('stale'), { cost_usd: TABLE_COST, cost_source: 'estimated' });
      assert.equal(report.updated, 1);
    });

    test('a missing-only fill labels what it prices as estimated', () => {
      legacy('gap', null);
      recalculateEventCosts(getDb(), { apply: true, missingOnly: true });
      assert.deepEqual(rowOf('gap'), { cost_usd: TABLE_COST, cost_source: 'estimated' });
    });

    test('a dry run reports as applying would, and writes nothing, labels included', () => {
      legacy('stale', 0.5, { source: 'import', agent: 'codex' });
      legacy('gap', null);
      const report = recalculateEventCosts(getDb(), { apply: false });
      assert.equal(report.costs_attributed, 1);
      assert.equal(report.updated, 2, 'the codex estimate is re-derivable and the gap is priced');
      assert.deepEqual(rowOf('stale'), { cost_usd: 0.5, cost_source: null });
      assert.deepEqual(rowOf('gap'), { cost_usd: null, cost_source: null });
    });

    test('a recalc labels unlabelled rows first, so it cannot rewrite a reported cost', () => {
      legacy('otel-cost', 5, { source: 'otel' });
      recalculateEventCosts(getDb(), { apply: true });
      assert.deepEqual(rowOf('otel-cost'), { cost_usd: 5, cost_source: 'reported' });
    });
  });

  describe('rows written before provenance', () => {
    test('producers that never send a cost are estimates, even when rates have changed since', () => {
      legacy('codex-import', 0.5, { source: 'import', agent: 'codex' });
      legacy('antigravity-import', 0.5, { source: 'import', agent: 'antigravity' });
      attributeCostSources(getDb());
      for (const id of ['codex-import', 'antigravity-import']) {
        assert.equal(rowOf(id).cost_source, 'estimated', id);
      }
    });

    test('a Codex OTEL cost may be the producer\'s own, so it takes the table comparison', () => {
      // The OTLP parser reads gen_ai.usage.cost for any service.
      legacy('codex-otel-sent', 0.5, { source: 'otel', agent: 'codex' });
      legacy('codex-otel-priced', TABLE_COST, { source: 'otel', agent: 'codex' });
      attributeCostSources(getDb());
      assert.equal(rowOf('codex-otel-sent').cost_source, 'reported');
      assert.equal(rowOf('codex-otel-priced').cost_source, 'estimated');
    });

    test('a benchmark cost is reported', () => {
      legacy('bench', TABLE_COST, { source: 'benchmark', agent: 'codex' });
      attributeCostSources(getDb());
      assert.equal(rowOf('bench').cost_source, 'reported');
    });

    test('elsewhere, a cost equal to the tables is an estimate and any other is reported', () => {
      legacy('matches', TABLE_COST, { source: 'import' });
      legacy('differs', 1.5, { source: 'otel' });
      attributeCostSources(getDb());
      assert.equal(rowOf('matches').cost_source, 'estimated');
      assert.equal(rowOf('differs').cost_source, 'reported');
    });

    test('a row with no cost stays unlabelled, and labelling is idempotent', () => {
      legacy('none', null);
      legacy('once', TABLE_COST, { source: 'import' });
      assert.equal(attributeCostSources(getDb()), 1);
      assert.equal(attributeCostSources(getDb()), 0);
      assert.equal(rowOf('none').cost_source, null);
    });
  });
});
