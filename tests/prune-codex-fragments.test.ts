import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type Database from 'better-sqlite3';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-prune-fragments-'));
const dbPath = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_DB_PATH = dbPath;

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');
const { acquireRuntimeOwnership, RuntimeOwnershipError } = await import('../src/runtime-ownership.js');
const { pruneCodexStreamFragments } = await import('../src/db/prune-codex-fragments.js');

const SESSION = 'codex-fragment-session';
const fragment = (eventId: string, kind: string, eventName = 'codex.sse_event') => ({
  event_id: eventId, session_id: SESSION, agent_type: 'codex', event_type: 'response' as const,
  status: 'success' as const, tokens_in: 0, tokens_out: 0, source: 'otel',
  client_timestamp: '2026-10-20T10:00:01Z', metadata: { otel_event_name: eventName, event_kind: kind },
});

function seed(db: Database.Database): void {
  for (const table of ['session_items', 'session_turns', 'session_trace_summary', 'browsing_sessions', 'events', 'sessions', 'agents']) {
    db.exec(`DELETE FROM ${table}`);
  }
  insertEvent({
    event_id: 'otel-prompt', session_id: SESSION, agent_type: 'codex', event_type: 'user_prompt', status: 'success',
    tokens_in: 0, tokens_out: 0, source: 'otel', client_timestamp: '2026-10-20T10:00:00Z',
    metadata: { otel_event_name: 'codex.user_prompt', message: 'fix the build' },
  });
  insertEvent(fragment('otel-frag-1', 'response.custom_tool_call_input.delta'));
  insertEvent(fragment('otel-frag-2', 'response.created'));
  insertEvent(fragment('otel-frag-3', 'response.output_item.done'));
  insertEvent(fragment('otel-frag-4', 'response.output_text.delta', 'codex.websocket_event'));
  // Neighbours the prune must leave: usage, a non-fragment kind, a fragment
  // kind that carries more than the two marker keys, and other agents/sources.
  insertEvent({
    event_id: 'otel-completed', session_id: SESSION, agent_type: 'codex', event_type: 'llm_response', status: 'success',
    tokens_in: 900, tokens_out: 40, cache_read_tokens: 100, model: 'gpt-5.6-sol', cost_usd: 0.25, source: 'otel',
    client_timestamp: '2026-10-20T10:00:02Z', metadata: { otel_event_name: 'codex.sse_event', event_kind: 'response.completed' },
  });
  insertEvent(fragment('otel-compacting', 'response.compaction.compacting'));
  insertEvent({ ...fragment('otel-with-text', 'response.output_text.done'), metadata: {
    otel_event_name: 'codex.sse_event', event_kind: 'response.output_text.done', text: 'kept',
  } });
  insertEvent({ ...fragment('otel-with-usage', 'response.created'), tokens_in: 5 });
  insertEvent({ ...fragment('import-shaped', 'response.created'), source: 'import' });
  insertEvent({ ...fragment('claude-shaped', 'response.created'), agent_type: 'claude_code', session_id: 'claude-session' });
  maintainSessionTraceSummary(SESSION);
}

const FRAGMENT_IDS = ['otel-frag-1', 'otel-frag-2', 'otel-frag-3', 'otel-frag-4'];

function rows(table: string, where = '1=1'): unknown[] {
  return getDb().prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`).all();
}
function survivors() {
  const ids = FRAGMENT_IDS.map(id => `'${id}'`).join(',');
  return {
    events: rows('events', `event_id NOT IN (${ids})`),
    turns: rows('session_turns', `source_turn_id NOT IN (${ids})`),
    items: rows('session_items'),
  };
}
function everything() {
  return ['events', 'session_turns', 'session_items', 'session_trace_summary', 'browsing_sessions']
    .map(table => getDb().prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}
function observationCount(): number {
  return (getDb().prepare('SELECT observation_count FROM session_trace_summary WHERE session_id = ?').get(SESSION) as
    { observation_count: number }).observation_count;
}

describe('pruneCodexStreamFragments', () => {
  before(() => {
    initSchema();
    assert.equal(getDb().name, dbPath);
  });
  beforeEach(() => seed(getDb()));
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a preview counts the stored fragments and their turns without changing anything', () => {
    const before = everything();
    const preview = pruneCodexStreamFragments({ dbPath });
    assert.equal(preview.applied, false);
    assert.deepEqual(
      { rows: preview.rows, sessions: preview.sessions, turns: preview.turns, items: preview.items },
      { rows: 4, sessions: 1, turns: 4, items: 0 },
    );
    assert.match(preview.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(everything(), before);
  });

  test('an apply removes the fragments and their turns, rebuilds the summary, and leaves every neighbour', () => {
    const kept = survivors();
    const observationsBefore = observationCount();
    const preview = pruneCodexStreamFragments({ dbPath });
    const applied = pruneCodexStreamFragments({ dbPath, expectDigest: preview.digest });

    assert.equal(applied.applied, true);
    assert.equal(applied.rows, 4);
    const ids = FRAGMENT_IDS.map(id => `'${id}'`).join(',');
    assert.deepEqual(rows('events', `event_id IN (${ids})`), []);
    assert.deepEqual(rows('session_turns', `source_turn_id IN (${ids})`), []);
    assert.deepEqual(survivors(), kept);
    assert.equal(observationCount(), observationsBefore - 4, 'the summary no longer counts the fragments');

    const again = pruneCodexStreamFragments({ dbPath });
    assert.equal(again.rows, 0);
    assert.equal(pruneCodexStreamFragments({ dbPath, expectDigest: again.digest }).rows, 0);
  });

  test('an apply with a stale digest changes nothing', () => {
    const before = everything();
    assert.throws(() => pruneCodexStreamFragments({ dbPath, expectDigest: 'a'.repeat(64) }), /preview again/);
    assert.deepEqual(everything(), before);
  });

  test('an apply refuses while another runtime owns the database', () => {
    const before = everything();
    const preview = pruneCodexStreamFragments({ dbPath });
    const owner = acquireRuntimeOwnership(dbPath);
    try {
      assert.throws(() => pruneCodexStreamFragments({ dbPath, expectDigest: preview.digest }), RuntimeOwnershipError);
    } finally {
      owner.release();
    }
    assert.deepEqual(everything(), before);
  });

  test('a failure part-way through rolls the whole prune back', () => {
    const before = everything();
    const preview = pruneCodexStreamFragments({ dbPath });
    // Turns are removed before events, so a failing event delete strands them
    // unless the prune is one transaction.
    getDb().exec(`CREATE TEMP TRIGGER fail_event_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      assert.throws(() => pruneCodexStreamFragments({ dbPath, expectDigest: preview.digest }), /injected/);
    } finally {
      getDb().exec('DROP TRIGGER fail_event_delete');
    }
    assert.deepEqual(everything(), before);
  });
});
