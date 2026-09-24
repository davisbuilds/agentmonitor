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

  test('a session whose reconcile fails is reported as failed, not unreadable, and the run continues', async () => {
    const other = v7('2026-07-25T20:53:37Z', '0000000000ee');
    write(other, [meta(other), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10), count(2, 3000, 1000, 30), count(3, 6000, 2000, 60)]);
    storeChildAsBefore();
    write(other, [meta(other), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10)]);
    assert.ok(usageTotal(CHILD) > 30_500, 'the child must still hold its copied history');
    // The child's reconcile fails for a reason that has nothing to do with reading its file.
    getDb().exec(`
      CREATE TEMP TRIGGER fail_child_delete BEFORE DELETE ON events WHEN OLD.session_id = '${CHILD}'
      BEGIN SELECT RAISE(ABORT, 'injected reconcile failure'); END;
    `);
    try {
      const report = repair(true);
      assert.equal(report.files_unreadable, 0);
      assert.equal(report.sessions_without_rollout, 0, 'a failed session still has its rollout');
      assert.equal(report.sessions_failed.length, 1);
      assert.match(report.sessions_failed[0].error, /injected reconcile failure/);
      assert.equal(report.rows_by_class.orphaned, 2, 'the other session is still repaired');
      assert.equal(report.rows_by_class.copied_history, 0, 'the failed session is not counted as repaired');
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_child_delete');
    }
  });

  test('the CLI exits with partial success when any session fails', async () => {
    storeChildAsBefore();
    const { main } = await import('../src/cli.js');
    const { Writable } = await import('node:stream');
    const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
    getDb().exec(`
      CREATE TEMP TRIGGER fail_child_delete BEFORE DELETE ON events WHEN OLD.session_id = '${CHILD}'
      BEGIN SELECT RAISE(ABORT, 'injected reconcile failure'); END;
    `);
    try {
      const { partialSuccess } = await import('../src/cli/errors.js');
      const result = await main(['node', 'amon', 'costs', 'repair-codex-usage', '--apply', '--codex-dir', codexDir, '--json'], { stdout: sink(), stderr: sink() });
      assert.equal(result.exitCode, partialSuccess('').exitCode);
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_child_delete');
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

  const plain = (tail: string) => v7('2026-07-25T20:53:37Z', tail);
  const setConfigModel = (model: string) => fs.writeFileSync(path.join(codexDir, 'config.toml'), `model = "${model}"\n`);
  const storedModels = (sessionId: string) => (getDb().prepare(
    "SELECT DISTINCT model FROM events WHERE session_id = ? AND event_id LIKE 'import-cdx-%' ORDER BY model",
  ).all(sessionId) as { model: string | null }[]).map(row => row.model);
  const addOtel = (sessionId: string) => getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, cache_read_tokens, source, client_timestamp)
    VALUES (?, ?, 'codex', 'llm_response', 'success', 1000, 10, 0, 'otel', '2026-07-25 21:01:00')
  `).run(`otel-${sessionId}`, sessionId);

  test('a subagent\'s session model moves from its parent\'s first turn to its own, classified as such', () => {
    const parentTurns = copiedPrefix.map(line => (line.type === 'turn_context'
      ? { ...line, payload: { ...(line.payload as Record<string, unknown>), model: 'gpt-5.5' } }
      : line));
    write(CHILD, [meta(CHILD, 'cli'), ...parentTurns, ...childOwn]);
    importAll();
    write(CHILD, [meta(CHILD, spawnSource), ...parentTurns, ...childOwn]);
    const start = () => (getDb().prepare("SELECT model FROM events WHERE session_id = ? AND event_type = 'session_start'").get(CHILD) as { model: string }).model;
    assert.equal(start(), 'gpt-5.5', 'the fixture must store the parent\'s model');
    // Only the session_start takes this class: another row's model change is still unexplained.
    getDb().prepare("UPDATE events SET model = 'gpt-5.5' WHERE session_id = ? AND event_type = 'session_end'").run(CHILD);

    const report = repair(true);
    assert.equal(report.rows_by_class.subagent_model, 1);
    assert.equal(report.rows_by_class.unclassified, 1);
    assert.equal(start(), 'gpt-5.6-sol');
  });

  test('a plain session\'s changed session model stays unclassified', () => {
    const id = plain('000000000c9f');
    write(id, [meta(id), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10)]);
    importAll();
    getDb().prepare("UPDATE events SET model = 'gpt-5.5' WHERE session_id = ? AND event_type = 'session_start'").run(id);

    const report = repair(true);
    assert.equal(report.rows_by_class.subagent_model, 0);
    assert.equal(report.rows_by_class.unclassified, 1);
  });

  test('a model known only from config.toml is not rewritten when the config changes', () => {
    const id = plain('000000000c0f');
    setConfigModel('gpt-5.6-sol');
    // No turn_context: the rollout never names its model.
    write(id, [meta(id), count(1, 6000, 5000, 100)]);
    importAll();
    setConfigModel('gpt-6-sol');

    const report = repair(true);
    assert.equal(report.rows_updated, 0);
    assert.equal(report.rows_by_class.unclassified, 0);
    assert.deepEqual(storedModels(id), ['gpt-5.6-sol']);
  });

  test('a config-model row whose tokens change keeps its stored model and is priced with it', () => {
    const id = plain('000000000c1f');
    setConfigModel('gpt-5.6-sol');
    write(id, [meta(id), count(1, 6000, 5000, 100)]);
    importAll();
    setConfigModel('gpt-6-sol');
    getDb().prepare('UPDATE events SET tokens_in = tokens_in + 7 WHERE event_id = ?').run(llmRow(id, 0));

    const report = repair(true);
    assert.equal(report.rows_by_class.refresh_drift, 1);
    assert.equal(report.rows_by_class.unclassified, 0);
    const row = getDb().prepare('SELECT tokens_in, model, cost_usd FROM events WHERE event_id = ?').get(llmRow(id, 0)) as { tokens_in: number; model: string; cost_usd: number };
    assert.deepEqual([row.tokens_in, row.model], [1000, 'gpt-5.6-sol']);
    assert.ok(Math.abs(row.cost_usd - 0.0105) < 1e-12, `priced as gpt-5.6-sol: ${row.cost_usd}`);
    assert.ok(Math.abs(report.cost_after_usd - 0.0105) < 1e-12, `the report prices it the same way: ${report.cost_after_usd}`);
  });

  test('a cost that differs only by floating-point rounding is not rewritten', () => {
    const id = plain('000000000c2f');
    write(id, [meta(id), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10), count(2, 3000, 1000, 30)]);
    importAll();
    const changed = getDb().prepare(
      "UPDATE events SET cost_usd = cost_usd * (1 + 1e-12) WHERE session_id = ? AND cost_usd > 0",
    ).run(id).changes;
    assert.equal(changed, 2, 'the fixture must perturb the priced rows');

    const report = repair(true);
    assert.deepEqual([report.sessions_changed, report.rows_updated], [0, 0]);
  });

  test('only a session the repair takes to zero usage is listed as left without usage', () => {
    const emptied = plain('000000000c3f');
    const alreadyEmpty = plain('000000000c4f');
    write(emptied, [meta(emptied), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10)]);
    write(alreadyEmpty, [meta(alreadyEmpty), turnAt('2026-07-25T20:53:40Z')]);
    importAll();
    write(emptied, [meta(emptied), turnAt('2026-07-25T20:53:40Z')]);
    getDb().prepare("UPDATE events SET client_timestamp = '2026-07-25T22:00:00Z' WHERE session_id = ? AND event_type = 'session_end'").run(alreadyEmpty);
    addOtel(emptied);
    addOtel(alreadyEmpty);

    const report = repair(true);
    assert.equal(report.sessions_changed, 2);
    assert.deepEqual(report.sessions_left_without_usage, [emptied]);
  });

  test('a changed plain session is checked against the rollout\'s own final counter', () => {
    const agrees = plain('000000000c5f');
    const clamped = plain('000000000c6f');
    const reset = plain('000000000c7f');
    const turn = turnAt('2026-07-25T20:53:40Z');
    write(agrees, [meta(agrees), turn, count(1, 1000, 0, 10), count(2, 3000, 1000, 30)]);
    // Cached input growing faster than input is clamped, so the rows cannot add up to the counter.
    write(clamped, [meta(clamped), turn, count(1, 1000, 0, 10), count(2, 1100, 900, 20)]);
    // The counter drops once: the final counter understates what was billed.
    write(reset, [meta(reset), turn, count(1, 5000, 0, 50), count(2, 1000, 0, 10), count(3, 3000, 0, 30)]);
    importAll();
    for (const id of [agrees, clamped, reset]) {
      getDb().prepare('UPDATE events SET tokens_in = tokens_in + 7 WHERE event_id = ?').run(llmRow(id, 0));
    }

    const report = repair(true);
    assert.equal(report.sessions_changed, 3);
    assert.equal(report.counter_sessions_checked, 2);
    assert.equal(report.counter_sessions_reset, 1);
    assert.deepEqual(report.counter_mismatches, [clamped]);
    const end = getDb().prepare("SELECT metadata FROM events WHERE session_id = ? AND event_type = 'session_end'").get(reset) as { metadata: string };
    assert.equal(JSON.parse(end.metadata)._counter_resets, 1);
  });

  test('subagents are left to the OTEL check, and plain sessions to the counter check', () => {
    const other = plain('000000000c8f');
    write(other, [meta(other), turnAt('2026-07-25T20:53:40Z'), count(1, 1000, 0, 10), count(2, 3000, 1000, 30)]);
    storeChildAsBefore();
    assert.ok(usageTotal(CHILD) > 30_500, 'the child must still hold its copied history');
    getDb().prepare('UPDATE events SET tokens_in = tokens_in + 7 WHERE event_id = ?').run(llmRow(other, 0));
    addOtel(other);
    addOtel(CHILD);

    const report = repair(true);
    assert.equal(report.sessions_changed, 2);
    assert.equal(report.counter_sessions_checked, 1, 'the child is not compared with a counter that includes its parent');
    assert.equal(report.otel_sessions_checked, 1, 'only the child is compared with OTEL');
    assert.deepEqual(report.subagent_otel.map(check => check.session_id), [CHILD]);
  });
});
