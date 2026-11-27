import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before, beforeEach, describe } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { updateIdleSessions as updateIdleSessionsFn } from '../src/db/queries.js';
import type { getLiveSession as getLiveSessionFn, listLiveSessions as listLiveSessionsFn } from '../src/db/v2-queries.js';
import type { hashFile as hashImportFileFn, parseAntigravityFile as parseAgrFileFn } from '../src/import/antigravity.js';
import type { repairAntigravityImportUsage as repairAgrFn } from '../src/import/antigravity-usage-repair.js';
import type { readAntigravityConversationSnapshot as readSnapshotFn } from '../src/import/antigravity/snapshot.js';
import type { runImport as runImportFn } from '../src/import/index.js';
import type { parseAntigravitySessions as parseAgrSessionsFn } from '../src/parser/antigravity-sessions.js';
import type { broadcaster as broadcasterType } from '../src/sse/emitter.js';
import type { hashAntigravityDb as hashAgrDbFn, syncAntigravitySessionFileDetailed as syncAgrDetailedFn } from '../src/watcher/index.js';
import type { startWatcher as startWatcherFn, stopWatcher as stopWatcherFn } from '../src/watcher/service.js';
import type { createApp as createAppFn } from '../src/app.js';

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
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: number;
  messageId?: string;
  providerId?: string;
  createdSecs?: number;
}): Buffer {
  const gm: number[] = [];
  if (opts.model !== undefined) gm.push(...sField(19, opts.model));
  const u: number[] = [
    ...vField(1, 1531),
    ...vField(2, opts.input ?? 1000),
    ...vField(3, opts.output ?? 100),
  ];
  if (opts.cacheWrite !== undefined) u.push(...vField(4, opts.cacheWrite));
  if (opts.cacheRead !== undefined) u.push(...vField(5, opts.cacheRead));
  if (opts.messageId !== undefined) u.push(...sField(7, opts.messageId));
  if (opts.thinking !== undefined) u.push(...vField(9, opts.thinking));
  if (opts.providerId !== undefined) u.push(...sField(12, opts.providerId));
  gm.push(...lField(4, u));
  if (opts.createdSecs !== undefined) {
    gm.push(...lField(9, lField(4, [...vField(1, opts.createdSecs)])));
  }
  return buf(lField(1, gm));
}

function legacyAgrEventId(sessionId: string, tagName: string): string {
  const h = crypto.createHash('sha256').update(`antigravity:${sessionId}:${tagName}`).digest('hex').slice(0, 32);
  return `import-agr-${h}`;
}

async function holdExclusiveSqliteLock(
  dbPath: string,
  autoReleaseAfterMs?: number,
): Promise<() => Promise<void>> {
  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.dbPath);
    db.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    const view = new Int32Array(workerData.sab);
    if (workerData.autoReleaseAfterMs != null) {
      Atomics.wait(view, 0, 0, workerData.autoReleaseAfterMs);
    } else {
      Atomics.wait(view, 0, 0, 30000);
    }
    db.exec('COMMIT');
    db.close();
  `;
  const worker = new Worker(workerScript, { eval: true, workerData: { dbPath, sab, autoReleaseAfterMs } });
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
let claudeDir = '';
let codexHome = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let updateIdleSessions: typeof updateIdleSessionsFn;
let listLiveSessions: typeof listLiveSessionsFn;
let getLiveSession: typeof getLiveSessionFn;
let readAntigravityConversationSnapshot: typeof readSnapshotFn;
let hashFile: typeof hashImportFileFn;
let parseAntigravityFile: typeof parseAgrFileFn;
let repairAntigravityImportUsage: typeof repairAgrFn;
let parseAntigravitySessions: typeof parseAgrSessionsFn;
let runImport: typeof runImportFn;
let hashAntigravityDb: typeof hashAgrDbFn;
let syncAntigravitySessionFileDetailed: typeof syncAgrDetailedFn;
let startWatcher: typeof startWatcherFn;
let stopWatcher: typeof stopWatcherFn;
let broadcaster: typeof broadcasterType;
let createApp: typeof createAppFn;
let server: Server | undefined;
let baseUrl = '';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-slice2-'));
  claudeDir = path.join(tempDir, 'claude');
  codexHome = path.join(tempDir, 'codex');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'monitor.db');
  process.env.AGENTMONITOR_SESSION_TIMEOUT = '5';

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();

  ({ updateIdleSessions } = await import('../src/db/queries.js'));
  ({ listLiveSessions, getLiveSession } = await import('../src/db/v2-queries.js'));
  ({ readAntigravityConversationSnapshot } = await import('../src/import/antigravity/snapshot.js'));
  ({ hashFile, parseAntigravityFile } = await import('../src/import/antigravity.js'));
  ({ repairAntigravityImportUsage } = await import('../src/import/antigravity-usage-repair.js'));
  ({ parseAntigravitySessions } = await import('../src/parser/antigravity-sessions.js'));
  ({ runImport } = await import('../src/import/index.js'));
  ({ hashAntigravityDb, syncAntigravitySessionFileDetailed } = await import('../src/watcher/index.js'));
  ({ startWatcher, stopWatcher } = await import('../src/watcher/service.js'));
  ({ broadcaster } = await import('../src/sse/emitter.js'));
  ({ createApp } = await import('../src/app.js'));

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  broadcaster.closeAllClients();
  await stopWatcher();
  getDb().exec(`
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM import_state;
    DELETE FROM watched_files;
    DELETE FROM browsing_sessions;
    DELETE FROM messages;
    DELETE FROM tool_calls;
    DELETE FROM session_turns;
    DELETE FROM session_items;
    DELETE FROM session_trace_summary;
  `);
});

after(async () => {
  broadcaster.closeAllClients();
  await stopWatcher();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Slice 2: Antigravity shared snapshot reader, WAL parity, live Monitor cards, and stable IDs', () => {
  test('WAL-only writes flip shared hash token and update BOTH browsing_sessions and events/sessions without checkpoint', () => {
    const home = path.join(tempDir, 'home-wal-both');
    const id = '11111111-2222-3333-4444-555555555501';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const ts = Math.floor(Date.now() / 1000) - 600;
    const convDb = new Database(dbPath);
    try {
      convDb.pragma('journal_mode = WAL');
      convDb.pragma('wal_autocheckpoint = 0');
      convDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
      convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
      convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(ts));
      convDb.pragma('wal_checkpoint(TRUNCATE)');

      const hash0Importer = hashFile(dbPath);
      const hash0Watcher = hashAntigravityDb(dbPath);
      assert.equal(hash0Importer, hash0Watcher, 'importer and watcher share the exact WAL-aware token');

      const mainBytesBefore = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

      const sync0 = syncAntigravitySessionFileDetailed(getDb(), dbPath);
      assert.equal(sync0.result, 'parsed');
      assert.equal(getLiveSession(id)?.message_count, 1);

      const imp0 = runImport({ source: 'antigravity', antigravityDir: home });
      assert.equal(imp0.files[0]?.skippedUnchanged, true, 'importer skips unchanged file already synced by watcher');

      convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(1, 15, 3, plannerStepBlob({ messageId: 'm-wal-1' }), stepMetaBlob(ts + 5));
      convDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
        .run(0, genMetaBlob({ model: 'gemini-4-neon', input: 5000, output: 300, messageId: 'm-wal-1', createdSecs: ts + 5 }));

      const mainBytesAfter = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      assert.equal(mainBytesAfter, mainBytesBefore, 'main .db bytes remained unchanged in WAL-only write');

      const hash1Importer = hashFile(dbPath);
      const hash1Watcher = hashAntigravityDb(dbPath);
      assert.equal(hash1Importer, hash1Watcher);
      assert.notEqual(hash1Importer, hash0Importer, 'WAL-only write flipped shared token');

      const imp1 = runImport({ source: 'antigravity', antigravityDir: home });
      assert.equal(imp1.files[0]?.skippedUnchanged, false);
      assert.ok(imp1.totalEventsImported >= 2, 'importer picked up uncheckpointed WAL step and generation');

      const sync1 = syncAntigravitySessionFileDetailed(getDb(), dbPath);
      assert.equal(sync1.result, 'parsed');
      assert.equal(getLiveSession(id)?.message_count, 2);

      const llmRows = getDb().prepare(
        "SELECT tokens_in, tokens_out, event_id FROM events WHERE session_id = ? AND event_type = 'llm_response'",
      ).all(id) as Array<{ tokens_in: number; tokens_out: number; event_id: string }>;
      assert.equal(llmRows.length, 1);
      assert.equal(llmRows[0].tokens_in, 5000);
      assert.equal(llmRows[0].tokens_out, 300);

      convDb.pragma('wal_checkpoint(TRUNCATE)');
      const hashAfterCheckpoint = hashAntigravityDb(dbPath);
      assert.notEqual(hashAfterCheckpoint, hash1Watcher, 'checkpoint changes file hash');
      syncAntigravitySessionFileDetailed(getDb(), dbPath);
      const impAfterCheckpoint = runImport({ source: 'antigravity', antigravityDir: home });
      assert.equal(impAfterCheckpoint.totalEventsImported, 0, 'checkpoint causes zero duplicate events');
      assert.equal(
        (getDb().prepare("SELECT COUNT(*) c FROM events WHERE session_id = ? AND event_type = 'llm_response'").get(id) as { c: number }).c,
        1,
      );
    } finally {
      convDb.close();
    }
  });

  test('conversation_summaries.db WAL updates and partial trailing JSONL lines update hash and parse safely', () => {
    const home = path.join(tempDir, 'home-summary-wal');
    const id = '11111111-2222-3333-4444-555555555502';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const ts = Math.floor(Date.now() / 1000) - 600;
    const convDb = new Database(dbPath);
    convDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
    convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
    convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(ts));
    convDb.close();

    const summaryDbPath = path.join(home, 'conversation_summaries.db');
    const summaryDb = new Database(summaryDbPath);
    try {
      summaryDb.pragma('journal_mode = WAL');
      summaryDb.pragma('wal_autocheckpoint = 0');
      summaryDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          workspace_uris TEXT NOT NULL DEFAULT '[]',
          parent_conversation_id TEXT NOT NULL DEFAULT ''
        );
      `);
      summaryDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(
        id,
        'Initial Title',
        'Preview',
        JSON.stringify(['file:///Users/example/Dev/alpha']),
        '',
      );
      summaryDb.pragma('wal_checkpoint(TRUNCATE)');

      const hash0 = hashFile(dbPath);
      const summaryBytesBefore = crypto.createHash('sha256').update(fs.readFileSync(summaryDbPath)).digest('hex');

      summaryDb.prepare('UPDATE conversation_summaries SET title = ?, workspace_uris = ? WHERE conversation_id = ?')
        .run('Updated WAL Title', JSON.stringify(['file:///Users/example/Dev/beta']), id);

      const summaryBytesAfter = crypto.createHash('sha256').update(fs.readFileSync(summaryDbPath)).digest('hex');
      assert.equal(summaryBytesAfter, summaryBytesBefore, 'summary change sits solely in -wal');
      assert.notEqual(hashFile(dbPath), hash0, 'shared hash sees summary WAL update');
      assert.equal(parseAntigravityFile(dbPath)[0]?.project, 'beta');
      assert.equal(parseAntigravitySessions(dbPath).metadata.title, 'Updated WAL Title');

      const transcriptPath = path.join(home, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const completeLine = JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(ts * 1000).toISOString(),
        content: '<USER_REQUEST>\nCheck partial line tolerance\n</USER_REQUEST>',
      });
      fs.writeFileSync(transcriptPath, `${completeLine}\n{"step_index":1,"type":"PLAN`);
      const partialHash = hashAntigravityDb(dbPath);
      const partialParsed = parseAntigravitySessions(dbPath);
      assert.equal(partialParsed.messages.length, 1, 'complete line parses cleanly despite truncated trailing JSONL line');

      fs.writeFileSync(
        transcriptPath,
        `${completeLine}\n${JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date((ts + 5) * 1000).toISOString(), content: 'Done now.' })}\n`,
      );
      assert.notEqual(hashAntigravityDb(dbPath), partialHash, 'completing partial line flips hash');
      assert.equal(parseAntigravitySessions(dbPath).messages.length, 2);
    } finally {
      summaryDb.close();
    }
  });

  test('SQLITE_BUSY triggers bounded retry and fails without caching empty hash on lock exhaustion', async () => {
    const home = path.join(tempDir, 'home-busy');
    const id = '11111111-2222-3333-4444-555555555503';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const ts = Math.floor(Date.now() / 1000) - 600;
    const convDb = new Database(dbPath);
    convDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
    convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
    convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(ts));
    convDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
      .run(0, genMetaBlob({ model: 'gemini-4-neon', input: 4200, output: 111, messageId: 'm-busy-1', createdSecs: ts + 2 }));
    convDb.close();

    const releaseShort = await holdExclusiveSqliteLock(dbPath, 80);
    try {
      const recoveredSnapshot = readAntigravityConversationSnapshot(dbPath, {
        retryDelaysMs: [25, 50, 100, 150],
        busyTimeoutMs: 5,
        throwOnError: true,
      });
      assert.equal(recoveredSnapshot.steps.length, 1, 'short lock clears inside bounded retries');
      assert.equal(recoveredSnapshot.generations.length, 1);
    } finally {
      await releaseShort();
    }

    const releaseLong = await holdExclusiveSqliteLock(dbPath);
    try {
      assert.throws(() => {
        readAntigravityConversationSnapshot(dbPath, {
          retryDelaysMs: [10, 20],
          busyTimeoutMs: 1,
          throwOnError: true,
        });
      });

      const failedImport = runImport({ source: 'antigravity', antigravityDir: home });
      assert.ok(failedImport.files[0]?.error, 'exhausted lock fails import cleanly instead of treating DB as empty');
      assert.equal(
        getDb().prepare('SELECT * FROM import_state WHERE file_path = ?').get(dbPath),
        undefined,
        'failed busy read must NOT cache import_state hash',
      );
      const failedSync = syncAntigravitySessionFileDetailed(getDb(), dbPath);
      assert.equal(failedSync.result, 'error', 'watcher records error instead of skipping empty parse');
    } finally {
      await releaseLong();
    }

    const recoveredSync = syncAntigravitySessionFileDetailed(getDb(), dbPath);
    assert.equal(recoveredSync.result, 'parsed', 'once lock clears, next sync retries and succeeds');
    assert.equal(
      (getDb().prepare("SELECT tokens_in FROM events WHERE session_id = ? AND event_type = 'llm_response'").get(id) as { tokens_in: number } | undefined)?.tokens_in,
      4200,
    );
  });

  test('live watcher puts active root & subagent Antigravity sessions into Monitor Active Agents with ContextPill while historical stay ended', async () => {
    const home = path.join(tempDir, 'home-monitor-live');
    const rootId = 'aaaa1111-2222-3333-4444-555555555510';
    const childId = 'bbbb1111-2222-3333-4444-555555555511';
    const oldId = 'cccc1111-2222-3333-4444-555555555512';
    fs.mkdirSync(path.join(home, 'conversations'), { recursive: true });

    const nowSecs = Math.floor(Date.now() / 1000) - 20;
    const oldSecs = Math.floor(Date.now() / 1000) - 7200;

    const writeDb = (id: string, tsSecs: number, msgId: string, promptTokens: number, withFinish = true) => {
      const dbPath = path.join(home, 'conversations', `${id}.db`);
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
      db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
      const ins = db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
      ins.run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(tsSecs));
      ins.run(1, 15, 3, plannerStepBlob({ messageId: msgId }), stepMetaBlob(tsSecs + 2));
      if (withFinish) {
        ins.run(2, 12, 3, stepBlob(12, 12), stepMetaBlob(tsSecs + 3));
      }
      db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
        .run(0, genMetaBlob({ model: 'gemini-4-neon', input: promptTokens, output: 150, messageId: msgId, createdSecs: tsSecs + 2 }));
      return { db, dbPath };
    };

    const summaryDb = new Database(path.join(home, 'conversation_summaries.db'));
    summaryDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        parent_conversation_id TEXT NOT NULL DEFAULT ''
      );
    `);
    const insSummary = summaryDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
    insSummary.run(rootId, 'Root Live Session', 'Root', JSON.stringify(['file:///Users/example/Dev/alpha-repo']), '');
    insSummary.run(childId, 'Child Subagent Session', 'Child', JSON.stringify(['file:///Users/example/Dev/alpha-repo']), rootId);
    insSummary.run(oldId, 'Old Historical Session', 'Old', JSON.stringify(['file:///Users/example/Dev/old-repo']), '');
    summaryDb.close();

    const oldHandle = writeDb(oldId, oldSecs, 'msg-old-1', 9000);
    oldHandle.db.close();

    const sseChunks: string[] = [];
    const fakeRes = {
      writableEnded: false,
      destroyed: false,
      writeHead: () => fakeRes,
      write: (chunk: string) => {
        sseChunks.push(chunk);
        return true;
      },
      on: () => fakeRes,
      off: () => fakeRes,
      once: () => fakeRes,
      end: () => {},
    };
    broadcaster.addClient(fakeRes as unknown as Parameters<typeof broadcaster.addClient>[0]);

    startWatcher({ claudeDir, codexHome, antigravityDir: home });
    await delay(650);

    const oldRow = getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(oldId) as { status: string } | undefined;
    assert.equal(oldRow?.status, 'ended', 'historical Antigravity session stays ended on startup sync');
    assert.ok(!sseChunks.some(c => c.includes(oldId) && c.includes('"type":"event"')), 'historical session never emits live SSE event');

    const rootHandle = writeDb(rootId, nowSecs, 'msg-root-1', 210_000, true);
    const childHandle = writeDb(childId, nowSecs + 1, 'msg-child-1', 50_000, false);

    try {
      let activeIds: string[] = [];
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`${baseUrl}/api/sessions?exclude_status=ended&limit=0`);
        const body = await res.json() as { sessions: Array<{ id: string; status: string }> };
        activeIds = body.sessions.map(s => s.id);
        if (activeIds.includes(rootId) && activeIds.includes(childId)) break;
        await delay(100);
      }
      assert.ok(activeIds.includes(rootId), 'active root Antigravity session appears in /api/sessions');
      assert.ok(activeIds.includes(childId), 'active child Antigravity subagent appears in /api/sessions');
      assert.ok(!activeIds.includes(oldId), 'historical Antigravity session excluded from Active Agents');

      const monitorV2 = await (await fetch(`${baseUrl}/api/v2/monitor/sessions?exclude_status=ended&limit=0`)).json() as {
        sessions: Array<{ id: string; status: string; project: string | null }>;
      };
      const rootV2 = monitorV2.sessions.find(s => s.id === rootId);
      const childV2 = monitorV2.sessions.find(s => s.id === childId);
      assert.equal(rootV2?.status, 'active');
      assert.equal(rootV2?.project, 'alpha-repo');
      assert.equal(childV2?.status, 'active');

      const liveV2 = listLiveSessions({ limit: 500 });
      const liveRoot = liveV2.data.find(s => s.id === rootId);
      const liveChild = liveV2.data.find(s => s.id === childId);
      assert.ok(liveRoot && liveRoot.context_pct != null, 'root occupancy exposed for ContextPill');
      assert.ok(liveChild && liveChild.context_pct != null, 'child occupancy exposed for ContextPill');

      const joinedSse = sseChunks.join('');
      assert.ok(joinedSse.includes('"type":"event"') && joinedSse.includes(rootId), 'SSE event emitted for active Antigravity session');
      assert.ok(joinedSse.includes('"type":"event"') && joinedSse.includes(childId), 'SSE event emitted for active Antigravity subagent session');
      assert.ok(joinedSse.includes('"type":"session_parsed"') && joinedSse.includes(rootId), 'SSE session_parsed emitted');

      getDb().prepare("UPDATE sessions SET last_event_at = datetime('now', '-6 minutes') WHERE id = ?").run(rootId);
      const idleSweep = updateIdleSessions(5);
      assert.ok(idleSweep.transitions.some(t => t.session_id === rootId && t.status === 'idle'), 'idle_check moves quiet Antigravity session to idle');

      getDb().prepare("UPDATE sessions SET last_event_at = datetime('now', '-12 minutes') WHERE id = ?").run(rootId);
      const endSweep = updateIdleSessions(5);
      assert.ok(endSweep.transitions.some(t => t.session_id === rootId && t.status === 'ended'), 'idle_check moves stale Antigravity session to ended');
    } finally {
      rootHandle.db.close();
      childHandle.db.close();
    }
  });

  test('stable generation identity prefers messageId -> providerAssignedMessageId -> idx and prevents duplicates on legacy gen:i & reordered rows', () => {
    const home = path.join(tempDir, 'home-stable-id');
    const id = '11111111-2222-3333-4444-555555555504';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const ts = Date.UTC(2026, 10, 15, 10, 0, 0) / 1000;
    const convDb = new Database(dbPath);
    convDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
    convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
    convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(ts));
    const insGen = convDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
    insGen.run(0, genMetaBlob({ model: 'gemini-4-neon', input: 100, output: 10, messageId: 'msg-a', providerId: 'prov-a', createdSecs: ts + 1 }));
    insGen.run(1, genMetaBlob({ model: 'gemini-4-neon', input: 200, output: 20, providerId: 'prov-b', createdSecs: ts + 2 }));
    insGen.run(5, genMetaBlob({ model: 'gemini-4-neon', input: 300, output: 30, createdSecs: ts + 3 }));
    convDb.close();

    const parsed1 = parseAntigravityFile(dbPath).filter(e => e.event_type === 'llm_response');
    assert.deepEqual(parsed1.map(e => e.event_id), [
      legacyAgrEventId(id, 'gen:msg:msg-a'),
      legacyAgrEventId(id, 'gen:pmsg:prov-b'),
      legacyAgrEventId(id, 'gen:idx:5'),
    ]);

    const legacyDbPath = path.join(home, 'conversations', '22222222-2222-3333-4444-555555555504.db');
    const legacyId = '22222222-2222-3333-4444-555555555504';
    const ldb = new Database(legacyDbPath);
    ldb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload, metadata);');
    ldb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
    ldb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(ts));
    ldb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
      .run(0, genMetaBlob({ model: 'gemini-4-neon', input: 900, output: 90, messageId: 'msg-legacy-0', createdSecs: ts + 1 }));
    ldb.close();

    getDb().prepare(`
      INSERT INTO sessions (id, agent_id, agent_type, status, started_at, last_event_at, ended_at)
      VALUES (?, 'antigravity-default', 'antigravity', 'ended', datetime(?), datetime(?), datetime(?))
    `).run(legacyId, new Date(ts * 1000).toISOString(), new Date(ts * 1000).toISOString(), new Date(ts * 1000).toISOString());
    getDb().prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out, model, cost_usd, source)
      VALUES (?, ?, 'antigravity', 'llm_response', 'success', 2431, 90, 'gemini-4-neon', 0.01, 'import')
    `).run(legacyAgrEventId(legacyId, 'gen:0'), legacyId);

    const impForce = runImport({ source: 'antigravity', antigravityDir: home, force: true });
    assert.ok(impForce.totalDuplicates >= 1, 'preexisting legacy gen:0 row is bridged without duplicate insert');
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) c FROM events WHERE session_id = ? AND event_type = 'llm_response'").get(legacyId) as { c: number }).c,
      1,
      'zero duplicate llm_response rows inserted when legacy gen:0 exists',
    );
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) c FROM events WHERE session_id = ? AND event_type = 'llm_response'").get(id) as { c: number }).c,
      3,
    );

    const reorderedDb = new Database(dbPath);
    try {
      const rows = reorderedDb.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ idx: number; data: Buffer }>;
      reorderedDb.prepare('DELETE FROM gen_metadata').run();
      reorderedDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)').run(0, rows[1].data);
      reorderedDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)').run(1, rows[0].data);
      reorderedDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)').run(5, rows[2].data);
    } finally {
      reorderedDb.close();
    }
    const impReordered = runImport({ source: 'antigravity', antigravityDir: home, force: true });
    assert.equal(impReordered.totalEventsImported, 0, 'reordering repaired gen_metadata rows creates zero duplicate events');
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) c FROM events WHERE session_id = ? AND event_type = 'llm_response'").get(id) as { c: number }).c,
      3,
    );
  });

  test('reordered gen_metadata with preexisting legacy ordinal gen:i rows migrates identities without dropping new generations or double-counting', () => {
    const home = path.join(tempDir, 'home-legacy-reorder');
    const sessionId = '33333333-2222-3333-4444-555555555505';
    const dbPath = path.join(home, 'conversations', `${sessionId}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const ts = Date.UTC(2026, 10, 16, 9, 0, 0) / 1000;
    const firstIso = new Date(ts * 1000).toISOString();

    const convDb = new Database(dbPath);
    convDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
    convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
    convDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, stepBlob(14, 19), stepMetaBlob(ts));
    const insGen = convDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
    insGen.run(0, genMetaBlob({ model: 'gemini-4-neon', input: 200, output: 20, cacheRead: 40, messageId: 'msg-B', createdSecs: ts + 20 }));
    insGen.run(1, genMetaBlob({ model: 'gemini-4-neon', input: 300, output: 30, cacheRead: 60, messageId: 'msg-C', createdSecs: ts + 30 }));
    insGen.run(2, genMetaBlob({ model: 'gemini-4-neon', input: 100, output: 10, cacheRead: 20, messageId: 'msg-A', createdSecs: ts + 10 }));
    convDb.close();

    getDb().prepare(`
      INSERT INTO sessions (id, agent_id, agent_type, status, started_at, last_event_at, ended_at)
      VALUES (?, 'antigravity-default', 'antigravity', 'ended', datetime(?), datetime(?), datetime(?))
    `).run(sessionId, firstIso, firstIso, firstIso);

    const insEv = getDb().prepare(`
      INSERT INTO events (
        event_id, session_id, agent_type, event_type, status,
        tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
        model, cost_usd, client_timestamp, metadata, source
      ) VALUES (?, ?, 'antigravity', 'llm_response', 'success', ?, ?, ?, 0, 'gemini-4-neon', 0.5, ?, ?, 'import')
    `);
    insEv.run(legacyAgrEventId(sessionId, 'gen:0'), sessionId, 1631, 10, 20, firstIso, JSON.stringify({ _source: 'antigravity_db', thoughts_tokens: 0 }));
    insEv.run(legacyAgrEventId(sessionId, 'gen:1'), sessionId, 1731, 20, 40, firstIso, JSON.stringify({ _source: 'antigravity_db', thoughts_tokens: 0 }));

    const imported = runImport({ source: 'antigravity', antigravityDir: home });
    assert.equal(imported.totalEventsImported, 3, 'session_start, step:0, and genuinely new generation C are imported');

    const rowsAfterImport = getDb().prepare(`
      SELECT event_id, tokens_in, tokens_out, cache_read_tokens
      FROM events
      WHERE session_id = ? AND event_type = 'llm_response'
      ORDER BY tokens_out
    `).all(sessionId) as Array<{ event_id: string; tokens_in: number; tokens_out: number; cache_read_tokens: number }>;

    assert.equal(rowsAfterImport.length, 3, 'A, B, and new C appear once each with zero double-counting');
    assert.deepEqual(rowsAfterImport.map(r => r.event_id), [
      legacyAgrEventId(sessionId, 'gen:msg:msg-A'),
      legacyAgrEventId(sessionId, 'gen:msg:msg-B'),
      legacyAgrEventId(sessionId, 'gen:msg:msg-C'),
    ]);
    assert.equal(rowsAfterImport[2].tokens_in, 300, 'new generation C stored with clean uncached tokens');

    const repaired = repairAntigravityImportUsage(getDb(), { antigravityDir: home, apply: true });
    assert.equal(repaired.sessions_changed, 1);
    assert.equal(repaired.rows_updated, 2, 'legacy A and B rows still repaired after ID migration');

    const totals = getDb().prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out
      FROM events
      WHERE session_id = ? AND event_type = 'llm_response'
    `).get(sessionId) as { c: number; tokens_in: number; tokens_out: number };
    assert.deepEqual(totals, { c: 3, tokens_in: 600, tokens_out: 60 });

    const secondRepair = repairAntigravityImportUsage(getDb(), { antigravityDir: home, apply: true });
    assert.equal(secondRepair.sessions_changed, 0);
  });
});
