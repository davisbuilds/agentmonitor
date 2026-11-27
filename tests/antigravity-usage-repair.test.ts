import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { after, before, beforeEach, describe } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

import { main } from '../src/cli.js';
import { partialSuccess } from '../src/cli/errors.js';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { initSchema as initSchemaFn } from '../src/db/schema.js';
import type { repairAntigravityImportUsage as repairFn } from '../src/import/antigravity-usage-repair.js';
import type { hashFile as hashFileFn, parseAntigravityFile as parseAgrFileFn } from '../src/import/antigravity.js';
import type { readAntigravityConversationSnapshot as readSnapshotFn } from '../src/import/antigravity/snapshot.js';
import type { runImport as runImportFn } from '../src/import/index.js';
import type { acquireRuntimeOwnership as acquireOwnershipFn } from '../src/runtime-ownership.js';
import type { maintainSessionTraceSummary as maintainSummaryFn } from '../src/trace-quality/summary.js';

function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let b = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) b |= 0x80;
    out.push(b);
  } while (big > 0);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const vField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];
const lField = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const sField = (f: number, s: string) => lField(f, [...Buffer.from(s, 'utf-8')]);
const buf = (a: number[]) => Buffer.from(a);

function stepBlob(type: number, oneof: number, payload: number[] = [...vField(1, 1)]): Buffer {
  return buf([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, payload)]);
}

function plannerStepBlob(opts: { messageId?: string; providerId?: string } = {}): Buffer {
  const payload: number[] = [...sField(1, 'ok')];
  if (opts.messageId !== undefined) payload.push(...sField(6, opts.messageId));
  if (opts.providerId !== undefined) payload.push(...sField(15, opts.providerId));
  return stepBlob(15, 20, payload);
}

function stepMetaBlob(secs: number): Buffer {
  return buf(lField(1, [...vField(1, secs)]));
}

function genMetaBlob(opts: {
  model: string;
  modelEnum: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: number;
  messageId?: string;
  providerId?: string;
  createdSecs?: number;
}): Buffer {
  const u: number[] = [
    ...vField(1, opts.modelEnum),
    ...vField(2, opts.input),
    ...vField(3, opts.output),
  ];
  if (opts.cacheWrite !== undefined) u.push(...vField(4, opts.cacheWrite));
  if (opts.cacheRead !== undefined) u.push(...vField(5, opts.cacheRead));
  if (opts.messageId !== undefined) u.push(...sField(7, opts.messageId));
  if (opts.thinking !== undefined) u.push(...vField(9, opts.thinking));
  if (opts.providerId !== undefined) u.push(...sField(12, opts.providerId));
  const gm: number[] = [...sField(19, opts.model), ...lField(4, u)];
  if (opts.createdSecs !== undefined) {
    gm.push(...lField(9, lField(4, [...vField(1, opts.createdSecs)])));
  }
  return buf(lField(1, gm));
}

function legacyEventId(sessionId: string, tagName: string): string {
  const h = crypto.createHash('sha256').update(`antigravity:${sessionId}:${tagName}`).digest('hex').slice(0, 32);
  return `import-agr-${h}`;
}

async function holdExclusiveSqliteLock(dbPath: string): Promise<() => Promise<void>> {
  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.dbPath);
    db.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    const view = new Int32Array(workerData.sab);
    Atomics.wait(view, 0, 0, 30000);
    db.exec('COMMIT');
    db.close();
  `;
  const worker = new Worker(workerScript, { eval: true, workerData: { dbPath, sab } });
  await new Promise<void>((resolve, reject) => {
    worker.once('message', (msg) => { if (msg === 'locked') resolve(); });
    worker.once('error', reject);
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
    await new Promise<void>((resolve) => {
      if (worker.exitCode !== null) resolve();
      else worker.once('exit', () => resolve());
    });
  };
}

let tempDir = '';
let agrDir = '';
let dbPath = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let initSchema: typeof initSchemaFn;
let repairAntigravityImportUsage: typeof repairFn;
let parseAntigravityFile: typeof parseAgrFileFn;
let readAntigravityConversationSnapshot: typeof readSnapshotFn;
let hashFile: typeof hashFileFn;
let runImport: typeof runImportFn;
let acquireRuntimeOwnership: typeof acquireOwnershipFn;
let maintainSessionTraceSummary: typeof maintainSummaryFn;

function snapshotTables() {
  const db = getDb();
  return ['events', 'sessions', 'session_trace_summary', 'import_state'].map(table =>
    db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  );
}

function seedLegacySession(
  sessionId: string,
  firstSecs: number,
  genSecs: number,
  options: { alsoDuplicateNewId?: boolean; project?: string } = {},
): string {
  const file = path.join(agrDir, 'conversations', `${sessionId}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const convDb = new Database(file);
  convDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
  const insStep = convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
  insStep.run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(firstSecs));
  insStep.run(1, 15, 3, plannerStepBlob({ messageId: `msg-${sessionId}-0` }), stepMetaBlob(genSecs));
  const insGen = convDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
  insGen.run(0, genMetaBlob({
    model: 'gemini-4-neon',
    modelEnum: 1531,
    input: 1000,
    output: 200,
    cacheRead: 5000,
    thinking: 50,
    messageId: `msg-${sessionId}-0`,
  }));
  convDb.close();

  if (options.project) {
    const summaryPath = path.join(agrDir, 'conversation_summaries.db');
    const sdb = new Database(summaryPath);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        parent_conversation_id TEXT NOT NULL DEFAULT ''
      );
    `);
    sdb.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      'Legacy Session',
      'Preview',
      JSON.stringify([`file:///Users/example/Dev/${options.project}`]),
      '',
    );
    sdb.close();
  }

  const db = getDb();
  const firstIso = new Date(firstSecs * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, status, started_at, last_event_at, ended_at)
    VALUES (?, 'antigravity-default', 'antigravity', NULL, 'ended', datetime('now'), datetime('now'), datetime('now'))
  `).run(sessionId);

  const insEv = db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, model, project, cost_usd, cost_source,
      client_timestamp, metadata, source
    ) VALUES (?, ?, 'antigravity', ?, 'success', ?, ?, ?, 0, 'gemini-4-neon', NULL, ?, NULL, ?, ?, 'import')
  `);
  insEv.run(legacyEventId(sessionId, 'session_start'), sessionId, 'session_start', 0, 0, 0, null, firstIso, JSON.stringify({ _source: 'antigravity_db' }));
  insEv.run(legacyEventId(sessionId, 'step:0'), sessionId, 'user_prompt', 0, 0, 0, null, firstIso, JSON.stringify({ _source: 'antigravity_db', kind: 'user_input', step_type: 14 }));
  insEv.run(legacyEventId(sessionId, 'step:1'), sessionId, 'response', 0, 0, 0, null, new Date(genSecs * 1000).toISOString(), JSON.stringify({ _source: 'antigravity_db', kind: 'planner_response', step_type: 15 }));

  insEv.run(
    legacyEventId(sessionId, 'gen:0'),
    sessionId,
    'llm_response',
    2531,
    250,
    5000,
    0.99,
    firstIso,
    JSON.stringify({ _source: 'antigravity_db', thoughts_tokens: 50 }),
  );
  if (options.alsoDuplicateNewId) {
    insEv.run(
      legacyEventId(sessionId, `gen:msg:msg-${sessionId}-0`),
      sessionId,
      'llm_response',
      2531,
      250,
      5000,
      0.99,
      firstIso,
      JSON.stringify({ _source: 'antigravity_db', thoughts_tokens: 50 }),
    );
  }
  maintainSessionTraceSummary(sessionId);
  return file;
}

class CaptureStream extends Writable {
  output = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.output += chunk.toString();
    cb();
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-repair-'));
  agrDir = path.join(tempDir, 'antigravity');
  dbPath = path.join(tempDir, 'monitor.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;

  const conn = await import('../src/db/connection.js');
  getDb = conn.getDb;
  closeDb = conn.closeDb;
  ({ initSchema } = await import('../src/db/schema.js'));
  initSchema();

  ({ repairAntigravityImportUsage } = await import('../src/import/antigravity-usage-repair.js'));
  ({ parseAntigravityFile, hashFile } = await import('../src/import/antigravity.js'));
  ({ readAntigravityConversationSnapshot } = await import('../src/import/antigravity/snapshot.js'));
  ({ runImport } = await import('../src/import/index.js'));
  ({ acquireRuntimeOwnership } = await import('../src/runtime-ownership.js'));
  ({ maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js'));
});

beforeEach(() => {
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(dbPath));
  db.exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM import_state; DELETE FROM session_trace_summary;');
  fs.rmSync(agrDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(agrDir, 'conversations'), { recursive: true });
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Antigravity usage repair', () => {
  test('dry-run preview writes nothing and matches what apply commits', () => {
    const t0 = Date.UTC(2026, 10, 10, 12, 0, 0) / 1000;
    const t1 = t0 + 3600;
    seedLegacySession('agr-repair-01', t0, t1, { project: 'proj-alpha' });
    const beforeSnap = snapshotTables();

    const preview = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: false });
    assert.deepEqual(snapshotTables(), beforeSnap, 'preview must not mutate database');
    assert.equal(preview.apply, false);
    assert.equal(preview.sessions_changed, 1);
    assert.equal(preview.legacy_ids_migrated, 1);
    assert.ok(preview.tokens_in_after < preview.tokens_in_before);
    assert.ok(preview.cost_after_usd < preview.cost_before_usd);

    const applied = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
    assert.equal(applied.apply, true);
    assert.deepEqual({ ...preview, apply: true }, applied);
  });

  test('atomically migrates legacy IDs, fixes inflated tokens, timestamps, sessions bounds, trace summary, and import_state', () => {
    const t0 = Date.UTC(2026, 10, 11, 9, 0, 0) / 1000;
    const t1 = Date.UTC(2026, 10, 11, 10, 30, 0) / 1000;
    const file = seedLegacySession('agr-repair-02', t0, t1, { project: 'proj-beta' });

    const report = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
    assert.equal(report.sessions_changed, 1);
    assert.equal(report.legacy_ids_migrated, 1);

    const expected = parseAntigravityFile(file).find(e => e.event_type === 'llm_response')!;
    const rows = getDb().prepare("SELECT * FROM events WHERE session_id = ? AND event_type = 'llm_response'").all('agr-repair-02') as Array<{
      event_id: string;
      tokens_in: number;
      tokens_out: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
      cost_source: string;
      project: string;
      client_timestamp: string;
      metadata: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, expected.event_id);
    assert.equal(rows[0].tokens_in, 1000);
    assert.equal(rows[0].tokens_out, 200);
    assert.equal(rows[0].cache_read_tokens, 5000);
    assert.equal(rows[0].cost_source, 'estimated');
    assert.equal(rows[0].project, 'proj-beta');
    assert.equal(rows[0].client_timestamp, new Date(t1 * 1000).toISOString());
    assert.equal((JSON.parse(rows[0].metadata) as { timestamp_source: string }).timestamp_source, 'planner_message_id');

    const sess = getDb().prepare('SELECT project, status, last_event_at FROM sessions WHERE id = ?').get('agr-repair-02') as {
      project: string; status: string; last_event_at: string;
    };
    assert.equal(sess.project, 'proj-beta');
    assert.equal(sess.status, 'ended');
    assert.equal(sess.last_event_at, '2026-11-11 10:30:00');

    const summary = getDb().prepare('SELECT tokens_in, tokens_out, cost_usd, project FROM session_trace_summary WHERE session_id = ?').get('agr-repair-02') as {
      tokens_in: number; tokens_out: number; cost_usd: number; project: string;
    };
    assert.equal(summary.tokens_in, 1000);
    assert.equal(summary.tokens_out, 200);
    assert.equal(summary.project, 'proj-beta');

    const impState = getDb().prepare('SELECT file_hash FROM import_state WHERE file_path = ?').get(file) as { file_hash: string } | undefined;
    assert.equal(impState?.file_hash, hashFile(file));

    const second = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
    assert.equal(second.sessions_changed, 0);
    assert.equal(second.rows_inserted + second.rows_updated + second.rows_deleted, 0);

    const impAfter = runImport({ source: 'antigravity', antigravityDir: agrDir, force: true });
    assert.equal(impAfter.totalEventsImported, 0);
  });

  test('removes preexisting duplicate legacy ordinal row alongside canonical row with zero double-counting', () => {
    const t0 = Date.UTC(2026, 10, 12, 8, 0, 0) / 1000;
    const t1 = t0 + 120;
    seedLegacySession('agr-repair-dup', t0, t1, { alsoDuplicateNewId: true });

    const report = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
    assert.equal(report.rows_deleted, 1);
    const rows = getDb().prepare("SELECT event_id, tokens_in FROM events WHERE session_id = ? AND event_type = 'llm_response'").all('agr-repair-dup') as Array<{
      event_id: string; tokens_in: number;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokens_in, 1000);

    const convFile = path.join(agrDir, 'conversations', 'agr-repair-dup.db');
    const convDb = new Database(convFile);
    convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(2, 14, 3, stepBlob(14, 19), stepMetaBlob(t1 + 30));
    convDb.close();
    const withNewStep = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
    assert.equal(withNewStep.sessions_changed, 1);
    const stateAfterStep = getDb().prepare('SELECT file_hash FROM import_state WHERE file_path = ?').get(convFile) as { file_hash: string } | undefined;
    assert.notEqual(stateAfterStep?.file_hash, hashFile(convFile), 'missing step events must leave import_state behind so import ingests them');
  });

  test('rollback leaves failed session untouched, missing source counts sessions_without_source, and locked DB counts files_unreadable', async () => {
    const t0 = Date.UTC(2026, 10, 13, 8, 0, 0) / 1000;
    seedLegacySession('agr-fail-1', t0, t0 + 60);
    seedLegacySession('agr-ok-2', t0, t0 + 60);
    seedLegacySession('agr-missing-3', t0, t0 + 60);
    fs.rmSync(path.join(agrDir, 'conversations', 'agr-missing-3.db'));
    const lockedFile = seedLegacySession('agr-locked-4', t0, t0 + 60);

    getDb().exec(`
      CREATE TEMP TRIGGER fail_agr_repair BEFORE UPDATE ON events WHEN OLD.session_id = 'agr-fail-1'
      BEGIN SELECT RAISE(ABORT, 'injected antigravity repair failure'); END;
    `);
    const releaseLock = await holdExclusiveSqliteLock(lockedFile);
    try {
      const report = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
      assert.equal(report.sessions_without_source, 1);
      assert.equal(report.files_unreadable, 1);
      assert.equal(report.sessions_failed.length, 1);
      assert.match(report.sessions_failed[0].error, /injected antigravity repair failure/);
      assert.equal(report.sessions_changed, 1);

      const untouchedFail = getDb().prepare("SELECT tokens_in FROM events WHERE session_id = 'agr-fail-1' AND event_type = 'llm_response'").get() as { tokens_in: number };
      assert.equal(untouchedFail.tokens_in, 2531, 'rolled back failed session stays unmodified');

      const repairedOk = getDb().prepare("SELECT tokens_in FROM events WHERE session_id = 'agr-ok-2' AND event_type = 'llm_response'").get() as { tokens_in: number };
      assert.equal(repairedOk.tokens_in, 1000, 'healthy session still repairs cleanly');
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_agr_repair');
      await releaseLock();
    }
  });

  test('CLI supports --dry-run, --apply, --db-path, --antigravity-dir, --json, rejects conflicting flags, and checks runtime ownership', async () => {
    const t0 = Date.UTC(2026, 10, 14, 8, 0, 0) / 1000;
    seedLegacySession('agr-cli-1', t0, t0 + 30);

    const runCli = async (args: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const res = await main(['node', 'amon', ...args], { stdout, stderr });
      return { ...res, stdout: stdout.output, stderr: stderr.output };
    };

    const conflict = await runCli(['costs', 'repair-antigravity-usage', '--apply', '--dry-run']);
    assert.equal(conflict.exitCode, 2);

    const preview = await runCli(['--db-path', dbPath, 'costs', 'repair-antigravity-usage', '--dry-run', '--antigravity-dir', agrDir, '--json']);
    assert.equal(preview.exitCode, 0, preview.stderr);
    const previewJson = JSON.parse(preview.stdout) as { apply: boolean; sessions_changed: number };
    assert.equal(previewJson.apply, false);
    assert.equal(previewJson.sessions_changed, 1);

    const owner = acquireRuntimeOwnership(dbPath);
    try {
      const blocked = await runCli(['--db-path', dbPath, 'costs', 'repair-antigravity-usage', '--apply', '--antigravity-dir', agrDir, '--json']);
      assert.notEqual(blocked.exitCode, 0);
      assert.match(blocked.stderr, /Stop the server before applying/);
    } finally {
      owner.release();
    }

    const applied = await runCli(['--db-path', dbPath, 'costs', 'repair-antigravity-usage', '--apply', '--antigravity-dir', agrDir, '--json']);
    assert.equal(applied.exitCode, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout) as { apply: boolean; sessions_changed: number };
    assert.equal(appliedJson.apply, true);
    assert.equal(appliedJson.sessions_changed, 1);

    getDb().exec(`
      CREATE TEMP TRIGGER fail_cli_agr BEFORE DELETE ON events WHEN OLD.session_id = 'agr-cli-2'
      BEGIN SELECT RAISE(ABORT, 'injected cli failure'); END;
    `);
    seedLegacySession('agr-cli-2', t0, t0 + 30);
    getDb().exec(`
      DROP TRIGGER IF EXISTS fail_cli_agr;
      CREATE TEMP TRIGGER fail_cli_agr BEFORE UPDATE ON events WHEN OLD.session_id = 'agr-cli-2'
      BEGIN SELECT RAISE(ABORT, 'injected cli failure'); END;
    `);
    try {
      const partial = await runCli(['--db-path', dbPath, 'costs', 'repair-antigravity-usage', '--apply', '--antigravity-dir', agrDir, '--json']);
      assert.equal(partial.exitCode, partialSuccess('').exitCode);
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_cli_agr');
    }
  });

  test('corrupt or truncated source DB counts files_unreadable and leaves stored usage intact under preview and apply', () => {
    const t0 = Date.UTC(2026, 10, 15, 8, 0, 0) / 1000;
    const corruptFile = seedLegacySession('agr-corrupt-01', t0, t0 + 60);
    const stubFile = seedLegacySession('agr-empty-stub-01', t0, t0 + 60);
    fs.writeFileSync(corruptFile, Buffer.from('not-a-sqlite-database-corrupt-bytes'));
    fs.writeFileSync(stubFile, Buffer.alloc(0));

    assert.throws(
      () => readAntigravityConversationSnapshot(corruptFile, { includeTranscript: false, throwOnError: true }),
      /not a database|SQLITE_NOTADB/i,
    );
    const nonStrict = readAntigravityConversationSnapshot(corruptFile, { includeTranscript: false, throwOnError: false });
    assert.equal(nonStrict.dbPresent, false);

    const preview = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: false });
    assert.equal(preview.files_unreadable, 2);
    assert.equal(preview.rows_deleted, 0);
    assert.equal(preview.sessions_changed, 0);

    const applied = repairAntigravityImportUsage(getDb(), { antigravityDir: agrDir, apply: true });
    assert.equal(applied.files_unreadable, 2);
    assert.equal(applied.rows_deleted, 0);
    assert.equal(applied.sessions_changed, 0);

    const corruptRows = getDb().prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(tokens_in), 0) AS tokens_in FROM events WHERE session_id = 'agr-corrupt-01' AND event_type = 'llm_response'",
    ).get() as { c: number; tokens_in: number };
    const stubRows = getDb().prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(tokens_in), 0) AS tokens_in FROM events WHERE session_id = 'agr-empty-stub-01' AND event_type = 'llm_response'",
    ).get() as { c: number; tokens_in: number };
    assert.equal(corruptRows.c, 1);
    assert.equal(corruptRows.tokens_in, 2531);
    assert.equal(stubRows.c, 1);
    assert.equal(stubRows.tokens_in, 2531);
  });
});
