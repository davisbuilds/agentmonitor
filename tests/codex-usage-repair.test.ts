import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-usage-repair-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { runImport } = await import('../src/import/index.js');
const { hashContent } = await import('../src/import/codex.js');
const { repairCodexImportUsage } = await import('../src/import/codex-usage-repair.js');

const codexDir = path.join(tempDir, 'codex');
const sessionsDir = path.join(codexDir, 'sessions', '2026', '07', '25');

/** A UUIDv7 whose leading 48 bits encode `iso`, the way Codex mints ids. */
function v7(iso: string, tail: string): string {
  const hex = Date.parse(iso).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail}`;
}
const PARENT = v7('2026-07-20T09:00:00Z', '0000000a4e17');

type Line = Record<string, unknown>;
const meta = (id: string, source: unknown = 'cli'): Line => ({
  type: 'session_meta', timestamp: '2026-07-25T20:53:38Z',
  payload: { id, cwd: '/tmp/codex-repair-fixture', timestamp: '2026-07-25T20:53:37Z', source },
});
const spawnSource = { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } };
const turnAt = (issuedIso: string, model = 'gpt-5.6-sol'): Line => ({
  type: 'turn_context', timestamp: '2026-07-25T20:53:38Z', payload: { model, turn_id: v7(issuedIso, '0000000000aa') },
});
const count = (minute: number, input: number, cached: number, output: number): Line => ({
  type: 'event_msg', timestamp: `2026-07-25T21:${String(minute).padStart(2, '0')}:00Z`,
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
});

function rolloutPath(sessionId: string): string {
  return path.join(sessionsDir, `rollout-2026-07-25T20-53-37-${sessionId}.jsonl`);
}
function write(sessionId: string, lines: Line[]): string {
  const file = rolloutPath(sessionId);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
}
const importAll = () => runImport({ source: 'codex', codexDir });
const repair = (apply: boolean) => repairCodexImportUsage(getDb(), { codexDir, apply });

function snapshot() {
  const db = getDb();
  return ['events', 'session_items', 'session_turns', 'browsing_sessions', 'session_trace_summary', 'import_state']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}
function usageTotal(sessionId: string): number {
  return (getDb().prepare(`
    SELECT COALESCE(SUM(tokens_in + tokens_out + cache_read_tokens + cache_write_tokens), 0) AS t
    FROM events WHERE session_id = ? AND source = 'import' AND event_id LIKE 'import-cdx-%'
  `).get(sessionId) as { t: number }).t;
}
function llmRow(sessionId: string, index: number): string {
  return `import-cdx-${crypto.createHash('sha256').update(`codex:${sessionId}:token:${index}`).digest('hex').slice(0, 32)}`;
}

// The parent's history as a child rollout copies it: three requests.
const copiedPrefix: Line[] = [
  turnAt('2026-07-20T09:00:01Z'), count(1, 400_000, 300_000, 4_000),
  turnAt('2026-07-21T09:00:00Z'), count(2, 900_000, 700_000, 9_000), count(3, 1_500_000, 1_200_000, 15_000),
];
const CHILD = v7('2026-07-25T20:53:37Z', '00000000c41d');
const childOwn: Line[] = [turnAt('2026-07-25T20:53:40Z'), count(10, 1_530_000, 1_225_000, 15_500)];

/** Store the child as the importer did before the boundary: every counter billed. */
function storeChildAsBefore(): void {
  write(CHILD, [meta(CHILD, 'cli'), ...copiedPrefix, ...childOwn]);
  importAll();
  write(CHILD, [meta(CHILD, spawnSource), ...copiedPrefix, ...childOwn]);
}

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

describe('Codex usage repair', () => {
  test('a preview writes nothing and reports exactly what applying does', () => {
    storeChildAsBefore();
    const before = snapshot();

    const preview = repair(false);
    assert.deepEqual(snapshot(), before);
    const applied = repair(true);

    assert.equal(preview.apply, false);
    assert.equal(applied.apply, true);
    assert.deepEqual({ ...preview, apply: true }, applied);
    assert.ok(applied.rows_deleted > 0, 'the fixture must need a repair');
  });

  test('copied history is removed and the child keeps only its own usage', () => {
    storeChildAsBefore();
    const report = repair(true);

    assert.equal(report.rows_by_class.copied_history, 3);
    assert.equal(report.inherited_counters_skipped, 3);
    assert.equal(usageTotal(CHILD), 30_000 + 500);
    assert.ok(getDb().prepare('SELECT 1 FROM events WHERE event_id = ?').get(llmRow(CHILD, 3)), 'the child\'s own row survives under its id');
    assert.ok(report.tokens_after < report.tokens_before);
    assert.ok(report.cost_after_usd < report.cost_before_usd);
  });

  test('a second apply, or an import after it, changes nothing', () => {
    storeChildAsBefore();
    repair(true);
    const settled = snapshot();

    const again = repair(true);
    assert.deepEqual([again.sessions_changed, again.rows_inserted, again.rows_updated, again.rows_deleted], [0, 0, 0, 0]);
    const imported = importAll();
    assert.equal(imported.totalEventsImported + imported.totalEventsRefreshed + imported.totalEventsRemoved, 0);
    assert.deepEqual(snapshot().slice(0, 5), settled.slice(0, 5));
  });

  test('applying records the hash of the bytes it applied, and a preview records nothing', () => {
    storeChildAsBefore();
    const file = rolloutPath(CHILD);
    const stateBefore = getDb().prepare('SELECT file_hash FROM import_state WHERE file_path = ?').get(file);
    repair(false);
    assert.deepEqual(getDb().prepare('SELECT file_hash FROM import_state WHERE file_path = ?').get(file), stateBefore);
    repair(true);
    const state = getDb().prepare('SELECT file_hash FROM import_state WHERE file_path = ?').get(file) as { file_hash: string };
    assert.equal(state.file_hash, hashContent(fs.readFileSync(file)));
  });

  test('each changed row is classified by the evidence it carries', () => {
    const plain = (tail: string) => v7('2026-07-25T20:53:37Z', tail);
    const [orphaned, drifted, repriced, appended, unexplained] = ['00000000000b', '00000000000c', '00000000000d', '00000000000e', '00000000000f'].map(plain);
    const three: Line[] = [turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10), count(2, 3000, 1000, 30), count(3, 6000, 2000, 60)];
    for (const id of [orphaned, drifted, repriced, appended, unexplained]) write(id, [meta(id), ...three]);
    importAll();
    const db = getDb();
    // Orphaned: Codex rewrote the rollout shorter.
    write(orphaned, [meta(orphaned), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10)]);
    // Refresh drift: the old model refresh wrote the file's cost onto stale tokens.
    db.prepare('UPDATE events SET tokens_in = tokens_in + 7 WHERE event_id = ?').run(llmRow(drifted, 1));
    // Repriced: same tokens, a cost from older tables.
    db.prepare('UPDATE events SET cost_usd = cost_usd * 2 WHERE event_id = ?').run(llmRow(repriced, 1));
    // Appended: the session kept going after the last import.
    write(appended, [meta(appended), ...three, count(4, 9000, 3000, 90)]);
    // Unexplained: tokens and cost both disagree with the file.
    db.prepare('UPDATE events SET tokens_in = tokens_in + 7, cost_usd = cost_usd + 1 WHERE event_id = ?').run(llmRow(unexplained, 1));

    const report = repair(true);
    assert.equal(report.rows_by_class.orphaned, 2);
    assert.equal(report.rows_by_class.refresh_drift, 1);
    assert.equal(report.rows_by_class.repriced, 1);
    assert.equal(report.rows_by_class.appended, 1);
    assert.equal(report.rows_by_class.unclassified, 1);
    assert.equal(report.rows_by_class.copied_history, 0);
    // Every row the reconcile touched is in exactly one class.
    const classified = Object.values(report.rows_by_class).reduce((a, b) => a + b, 0);
    assert.equal(classified, report.rows_inserted + report.rows_updated + report.rows_deleted);
  });

  test('rows priced before cost provenance are labelled estimates when rewritten', () => {
    storeChildAsBefore();
    getDb().exec("UPDATE events SET cost_source = NULL WHERE event_id LIKE 'import-cdx-%'");
    getDb().prepare('UPDATE events SET cost_usd = cost_usd * 2 WHERE event_id = ?').run(llmRow(CHILD, 3));
    repair(true);
    const row = getDb().prepare('SELECT cost_source FROM events WHERE event_id = ?').get(llmRow(CHILD, 3)) as { cost_source: string };
    assert.equal(row.cost_source, 'estimated');
  });

  test('a session whose rollout is gone keeps its rows and is counted', () => {
    storeChildAsBefore();
    fs.rmSync(rolloutPath(CHILD));
    const before = snapshot();
    const report = repair(true);
    assert.equal(report.sessions_without_rollout, 1);
    assert.deepEqual(snapshot(), before);
  });

  test('a rollout that cannot own its session is counted and changes nothing', () => {
    storeChildAsBefore();
    write(CHILD, [...copiedPrefix, ...childOwn]);
    const before = snapshot().slice(0, 5);
    const report = repair(true);
    assert.equal(report.sessions_unreconciled, 1);
    assert.deepEqual(snapshot().slice(0, 5), before);
  });

  test('an unreadable rollout is counted and the rest of the run continues', () => {
    storeChildAsBefore();
    const other = v7('2026-07-25T20:53:37Z', '0000000000ff');
    const unreadable = write(other, [meta(other), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10)]);
    fs.chmodSync(unreadable, 0o000);
    try {
      const report = repair(true);
      assert.equal(report.files_unreadable, 1);
      assert.equal(report.rows_by_class.copied_history, 3, 'the readable rollout is still repaired');
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  });

  test('Codex OTEL usage checks the repair from outside: the child moves toward it', () => {
    storeChildAsBefore();
    // Codex's own per-request telemetry for the child's one request.
    getDb().prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, cache_read_tokens, source, client_timestamp)
      VALUES ('otel-child', ?, 'codex', 'llm_response', 'success', 5000, 500, 25000, 'otel', '2026-07-25 21:10:00')
    `).run(CHILD);

    const report = repair(true);
    assert.equal(report.otel_sessions_checked, 1);
    assert.equal(report.otel_ratios_moved_away, 0);
    assert.equal(report.subagent_otel.length, 1);
    const [check] = report.subagent_otel;
    assert.ok(check.ratio_before > 10, `before: ${check.ratio_before}`);
    assert.ok(Math.abs(check.ratio_after - 1) < 1e-9, `after: ${check.ratio_after}`);
    assert.equal(check.otel_gap_hours, 0);
    assert.deepEqual(report.sessions_left_without_usage, []);
  });
});
