import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe, mock } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-import-usage-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { runImport } = await import('../src/import/index.js');
const { parseCodexFile } = await import('../src/import/codex.js');
const { reconcileCodexImport } = await import('../src/import/codex-reconcile.js');
const { insertEvent } = await import('../src/db/queries.js');

const SESSION = '019f0000-0000-7000-8000-000000000001';
const codexDir = path.join(tempDir, 'codex');
const sessionsDir = path.join(codexDir, 'sessions', '2026', '07', '12');
const rollout = path.join(sessionsDir, `rollout-2026-07-12T10-00-00-${SESSION}.jsonl`);

type Line = Record<string, unknown>;
const meta = (id = SESSION): Line => ({
  type: 'session_meta',
  timestamp: '2026-07-12T10:00:00Z',
  payload: { id, cwd: '/tmp/codex-usage-fixture', timestamp: '2026-07-12T10:00:00Z', source: 'cli' },
});
const turn = (model = 'gpt-5.6-terra'): Line => ({ type: 'turn_context', timestamp: '2026-07-12T10:00:01Z', payload: { model } });
const counter = (minute: number, input: number, cached: number, output: number): Line => ({
  type: 'event_msg',
  timestamp: `2026-07-12T10:${String(minute).padStart(2, '0')}:00Z`,
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  },
});
const patch = (minute: number): Line => ({
  type: 'response_item',
  timestamp: `2026-07-12T10:${String(minute).padStart(2, '0')}:30Z`,
  payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch' },
});

function writeRollout(lines: Line[]): void {
  fs.writeFileSync(rollout, lines.map(l => JSON.stringify(l)).join('\n'));
}

type StoredRow = {
  id: number; event_id: string; event_type: string; tokens_in: number; tokens_out: number;
  cache_read_tokens: number; model: string | null; cost_usd: number | null; created_at: string;
  client_timestamp: string | null; source: string; agent_type: string;
};

function importRows(sessionId = SESSION): StoredRow[] {
  return getDb().prepare(`
    SELECT id, event_id, event_type, tokens_in, tokens_out, cache_read_tokens, model, cost_usd,
           created_at, client_timestamp, source, agent_type
    FROM events WHERE session_id = ? AND event_id LIKE 'import-cdx-%' ORDER BY event_id
  `).all(sessionId) as StoredRow[];
}

/** The rows a file's parse should leave, keyed the way the store keys them. */
function expectedRows(): Array<Pick<StoredRow, 'event_id' | 'event_type' | 'tokens_in' | 'tokens_out' | 'cache_read_tokens' | 'model' | 'client_timestamp'>> {
  const seen = new Set<string>();
  return parseCodexFile(rollout, { codexDir })
    .filter(e => { if (seen.has(e.event_id!)) return false; seen.add(e.event_id!); return true; })
    .map(e => ({
      event_id: e.event_id!, event_type: e.event_type, tokens_in: e.tokens_in, tokens_out: e.tokens_out,
      cache_read_tokens: e.cache_read_tokens ?? 0, model: e.model ?? null, client_timestamp: e.client_timestamp ?? null,
    }))
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
}

function shape(rows: StoredRow[]) {
  return rows.map(r => ({
    event_id: r.event_id, event_type: r.event_type, tokens_in: r.tokens_in, tokens_out: r.tokens_out,
    cache_read_tokens: r.cache_read_tokens, model: r.model, client_timestamp: r.client_timestamp,
  }));
}

function importCodex(extra: Record<string, unknown> = {}) {
  return runImport({ source: 'codex', codexDir, ...extra });
}

describe('Codex import reconciles a session to its rollout', () => {
  before(() => {
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  });
  beforeEach(() => {
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
    getDb().exec(`
      DELETE FROM events; DELETE FROM sessions; DELETE FROM import_state; DELETE FROM session_trace_summary;
      DELETE FROM session_items; DELETE FROM session_turns; DELETE FROM browsing_sessions;
    `);
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
  });
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a shortened rewrite leaves no row the parse no longer produces', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), patch(1), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    const firstIds = importRows().map(r => r.event_id);

    // Codex rewrote the rollout: the same session, fewer counters.
    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    importCodex();

    assert.deepEqual(shape(importRows()), expectedRows());
    assert.ok(firstIds.some(id => !importRows().some(r => r.event_id === id)), 'the fixture must actually orphan rows');
  });

  test('a changed counter updates tokens and cost together, keeping the row identity', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10)]);
    importCodex();
    const before = importRows().find(r => r.event_type === 'llm_response')!;

    writeRollout([meta(), turn(), counter(1, 400_000, 300_000, 5_000)]);
    importCodex();
    const after = importRows().find(r => r.event_type === 'llm_response')!;

    assert.equal(after.event_id, before.event_id);
    assert.equal(after.id, before.id, 'the row is updated in place');
    assert.equal(after.created_at, before.created_at, 'created_at is not moved to the repair time');
    assert.equal(after.tokens_in, 100_000);
    assert.equal(after.cache_read_tokens, 300_000);
    const expected = parseCodexFile(rollout, { codexDir }).find(e => e.event_type === 'llm_response')!;
    assert.equal(after.cost_usd, expected.cost_usd);
    const label = getDb().prepare('SELECT cost_source FROM events WHERE id = ?').get(after.id) as { cost_source: string };
    assert.equal(label.cost_source, 'estimated');
  });

  test('an unchanged forced re-import writes nothing', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30)]);
    importCodex();
    const before = importRows();

    const result = importCodex({ force: true });

    assert.equal(result.totalEventsImported, 0);
    assert.equal(result.totalEventsRefreshed, 0);
    assert.deepEqual(importRows(), before);
  });

  test('rows from other producers for the same session are never touched', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30)]);
    importCodex();
    // Through insertEvent, so the Codex rows get their own summary projection.
    const other = (eventId: string, source: string, agent = 'codex') => insertEvent({
      event_id: eventId, session_id: SESSION, agent_type: agent, event_type: 'llm_response', status: 'success',
      tokens_in: 100, tokens_out: 10, model: 'gpt-5.6-terra', cost_usd: 0.5, source, metadata: {},
      client_timestamp: '2026-07-12T10:05:00Z',
    });
    other('otel-row', 'otel');
    other('api-row', 'api');
    other('bench-row', 'benchmark');
    other('claude-row', 'import', 'claude_code');
    getDb().prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, source)
      VALUES (NULL, ?, 'codex', 'llm_response', 'success', 100, 10, 'import')
    `).run(SESSION);
    const projectedBefore = getDb().prepare(
      "SELECT source_turn_id FROM session_turns WHERE session_id = ? AND source_turn_id IN ('otel-row', 'api-row') ORDER BY 1",
    ).all(SESSION);
    assert.equal(projectedBefore.length, 2, 'the fixture must give other producers a projection to lose');

    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    const orphans = importRows().filter(r => !expectedRows().some(e => e.event_id === r.event_id)).length;
    const result = importCodex();

    assert.equal(result.totalEventsRemoved, orphans, 'only the importer\'s own stale rows are counted');
    assert.deepEqual(getDb().prepare(
      "SELECT source_turn_id FROM session_turns WHERE session_id = ? AND source_turn_id IN ('otel-row', 'api-row') ORDER BY 1",
    ).all(SESSION), projectedBefore);

    const others = getDb().prepare(`
      SELECT COALESCE(event_id, '(null)') AS id FROM events
      WHERE session_id = ? AND (event_id IS NULL OR event_id NOT LIKE 'import-cdx-%') ORDER BY id
    `).all(SESSION) as Array<{ id: string }>;
    assert.deepEqual(others.map(o => o.id), ['(null)', 'api-row', 'bench-row', 'claude-row', 'otel-row']);
  });

  test('the summary projection holds one turn and one item per row, with current tokens', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    writeRollout([meta(), turn(), counter(1, 400_000, 300_000, 5_000)]);
    importCodex();

    const ids = importRows().map(r => r.event_id).sort();
    const turns = (getDb().prepare('SELECT source_turn_id FROM session_turns WHERE session_id = ? ORDER BY 1').all(SESSION) as Array<{ source_turn_id: string }>).map(t => t.source_turn_id);
    const items = getDb().prepare('SELECT source_item_id, kind, payload_json FROM session_items WHERE session_id = ?').all(SESSION) as Array<{ source_item_id: string; kind: string; payload_json: string }>;
    assert.deepEqual(turns, ids);
    assert.deepEqual(items.map(i => i.source_item_id).sort(), ids);

    const llm = importRows().find(r => r.event_type === 'llm_response')!;
    const payload = JSON.parse(items.find(i => i.source_item_id === llm.event_id)!.payload_json);
    assert.equal(payload.tokens_in, 100_000);
    assert.equal(payload.cost_usd, llm.cost_usd);

    const counts = getDb().prepare('SELECT message_count, user_message_count FROM browsing_sessions WHERE id = ?').get(SESSION) as { message_count: number; user_message_count: number };
    const messages = items.filter(i => i.kind === 'user_message' || i.kind === 'assistant_message').length;
    assert.equal(counts.message_count, messages);
    assert.equal(counts.user_message_count, items.filter(i => i.kind === 'user_message').length);
  });

  test('the trace summary follows the reconciled rows', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    importCodex();

    const summary = getDb().prepare('SELECT cost_usd FROM session_trace_summary WHERE session_id = ?').get(SESSION) as { cost_usd: number };
    const parsed = parseCodexFile(rollout, { codexDir }).reduce((sum, e) => sum + (e.cost_usd ?? 0), 0);
    assert.ok(parsed > 0);
    assert.ok(Math.abs(summary.cost_usd - parsed) < 1e-12, `${summary.cost_usd} vs ${parsed}`);
  });

  test('a failure after the delete leaves the session exactly as it was, and a retry completes it', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    const before = importRows();
    const itemsBefore = getDb().prepare('SELECT COUNT(*) AS n FROM session_items WHERE session_id = ?').get(SESSION);

    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    const events = parseCodexFile(rollout, { codexDir });
    assert.throws(() => reconcileCodexImport(events, { apply: true, onAfterDelete: () => { throw new Error('injected'); } }), /injected/);
    assert.deepEqual(importRows(), before);
    assert.deepEqual(getDb().prepare('SELECT COUNT(*) AS n FROM session_items WHERE session_id = ?').get(SESSION), itemsBefore);

    const retry = reconcileCodexImport(events, { apply: true });
    assert.ok(retry.deleted > 0);
    assert.deepEqual(shape(importRows()), expectedRows());
  });

  test('a preview reports what applying would do and writes nothing', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    const before = importRows();
    writeRollout([meta(), turn(), counter(1, 1500, 500, 15), counter(4, 9000, 3000, 90)]);
    const events = parseCodexFile(rollout, { codexDir });

    const preview = reconcileCodexImport(events, { apply: false });
    assert.deepEqual(importRows(), before);
    const applied = reconcileCodexImport(events, { apply: true });
    assert.deepEqual({ ...preview }, { ...applied });
    assert.ok(applied.deleted > 0 && applied.updated > 0);
  });

  test('importing again after a reconcile reports no changes', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30)]);
    importCodex();
    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    importCodex();
    const settled = importRows();

    const again = reconcileCodexImport(parseCodexFile(rollout, { codexDir }), { apply: true });
    assert.deepEqual({ inserted: again.inserted, updated: again.updated, deleted: again.deleted }, { inserted: 0, updated: 0, deleted: 0 });
    assert.deepEqual(importRows(), settled);
  });

  test('the recorded hash is of the bytes that were parsed: the file is read once', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10)]);
    const reads = mock.method(fs, 'readFileSync');
    try {
      importCodex();
      const ofRollout = reads.mock.calls.filter(c => String(c.arguments[0]) === rollout).length;
      assert.equal(ofRollout, 1);
    } finally {
      reads.mock.restore();
    }
    const state = getDb().prepare('SELECT file_hash FROM import_state WHERE file_path = ?').get(rollout) as { file_hash: string };
    assert.equal(state.file_hash, crypto.createHash('sha256').update(fs.readFileSync(rollout)).digest('hex'));
  });

  test('a date-scoped import never deletes rows', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    const before = importRows().length;
    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    importCodex({ from: new Date('2026-07-01T00:00:00Z') });
    assert.equal(importRows().length, before);
  });

  test('a session shown as a full transcript is not rewritten into a summary', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    getDb().prepare("UPDATE browsing_sessions SET integration_mode = 'codex-jsonl' WHERE id = ?").run(SESSION);
    const before = importRows();

    writeRollout([meta(), turn(), counter(1, 1500, 500, 15)]);
    const result = reconcileCodexImport(parseCodexFile(rollout, { codexDir }), { apply: true });

    assert.equal(result.reconciled, false);
    assert.deepEqual(importRows(), before);
    const mode = getDb().prepare('SELECT integration_mode FROM browsing_sessions WHERE id = ?').get(SESSION) as { integration_mode: string };
    assert.equal(mode.integration_mode, 'codex-jsonl');
  });

  test('a rollout without session_meta cannot own a session, so nothing is deleted', () => {
    writeRollout([meta(), turn(), counter(1, 1000, 0, 10), counter(2, 3000, 1000, 30), counter(3, 6000, 2000, 60)]);
    importCodex();
    const before = importRows().length;
    writeRollout([turn(), counter(1, 1500, 500, 15)]);
    const result = reconcileCodexImport(parseCodexFile(rollout, { codexDir }), { apply: true });
    assert.equal(result.reconciled, false);
    assert.equal(result.deleted, 0);
    assert.ok(importRows().length >= before);
  });
});
