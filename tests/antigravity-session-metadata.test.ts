import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import Database from 'better-sqlite3';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { syncAntigravityLiveSession as syncAgrLiveFn } from '../src/live/antigravity-adapter.js';
import type { insertParsedSession as insertParsedFn } from '../src/parser/claude-code.js';
import type { parseAntigravitySessions as parseAgrFn } from '../src/parser/antigravity-sessions.js';
import type { parseAntigravityFile as parseAgrEventsFn } from '../src/import/antigravity.js';
import type { getLiveSession as getLiveSessionFn } from '../src/db/v2-queries.js';
import type { hashAntigravityDb as hashAgrFn, syncAllAntigravityFiles as syncAllAgrFn } from '../src/watcher/index.js';

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

const step = (type: number, oneof: number) =>
  buf([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, [...vField(1, 1)])]);
const meta = (secs: number) => buf(lField(1, [...vField(1, secs)]));
const genmeta = (model: string, u: Record<number, number>) =>
  buf(lField(1, [
    ...sField(19, model),
    ...lField(4, [...vField(1, u[1]), ...vField(2, u[2]), ...vField(3, u[3]), ...vField(5, u[5]), ...vField(9, u[9]), ...vField(10, u[10])]),
  ]));

function writeConversationDb(
  dbPath: string,
  generations: Array<{ model: string; sys: number; inp: number; out: number; cached: number }>,
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER, data BLOB);');
  db.exec('DELETE FROM steps; DELETE FROM gen_metadata;');
  const insStep = db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
  insStep.run(0, 14, 3, step(14, 19), meta(1782000000));
  insStep.run(1, 15, 3, step(15, 20), meta(1782000005));
  const insGen = db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
  generations.forEach((g, idx) => {
    insGen.run(idx, genmeta(g.model, { 1: g.sys, 2: g.inp, 3: g.out, 5: g.cached, 9: 0, 10: g.out }));
  });
  db.close();
}

function writeSummaryDb(
  home: string,
  rows: Array<{
    conversation_id: string;
    title?: string;
    preview?: string;
    workspace_uris?: string;
    parent_conversation_id?: string;
  }>,
): string {
  const summaryPath = path.join(home, 'conversation_summaries.db');
  const db = new Database(summaryPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      parent_conversation_id TEXT NOT NULL DEFAULT ''
    );
    DELETE FROM conversation_summaries;
  `);
  const ins = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, parent_conversation_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    ins.run(
      r.conversation_id,
      r.title ?? '',
      r.preview ?? '',
      r.workspace_uris ?? '[]',
      r.parent_conversation_id ?? '',
    );
  }
  db.close();
  return summaryPath;
}

let tempDir = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let parseAntigravitySessions: typeof parseAgrFn;
let syncAntigravityLiveSession: typeof syncAgrLiveFn;
let insertParsedSession: typeof insertParsedFn;
let hashAntigravityDb: typeof hashAgrFn;
let syncAllAntigravityFiles: typeof syncAllAgrFn;
let parseAntigravityFile: typeof parseAgrEventsFn;
let getLiveSession: typeof getLiveSessionFn;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-meta-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'monitor.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();

  ({ parseAntigravitySessions } = await import('../src/parser/antigravity-sessions.js'));
  ({ syncAntigravityLiveSession } = await import('../src/live/antigravity-adapter.js'));
  ({ insertParsedSession } = await import('../src/parser/claude-code.js'));
  ({ hashAntigravityDb, syncAllAntigravityFiles } = await import('../src/watcher/index.js'));
  ({ parseAntigravityFile } = await import('../src/import/antigravity.js'));
  ({ getLiveSession } = await import('../src/db/v2-queries.js'));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Antigravity gen_metadata occupancy and conversation_summaries metadata', () => {
  test('extracts latest gen_metadata prompt occupancy and summary project, title, and subagent lineage', () => {
    const home = path.join(tempDir, 'home-1');
    const rootId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';
    const rootDb = path.join(home, 'conversations', `${rootId}.db`);
    const childDb = path.join(home, 'conversations', `${childId}.db`);

    writeConversationDb(rootDb, [
      { model: 'gemini-4-neon', sys: 1000, inp: 2000, out: 500, cached: 10_000 },
      { model: 'gemini-4-neon', sys: 1500, inp: 3000, out: 900, cached: 350_000 },
    ]);
    writeConversationDb(childDb, [
      { model: 'gemini-4-neon', sys: 0, inp: 0, out: 0, cached: 0 },
    ]);
    writeSummaryDb(home, [
      {
        conversation_id: rootId,
        title: 'Build Antigravity Parity',
        preview: 'Long preview text',
        workspace_uris: JSON.stringify(['file:///Users/example/Dev/agentmonitor']),
        parent_conversation_id: '',
      },
      {
        conversation_id: childId,
        title: '',
        preview: 'Subagent preview fallback',
        workspace_uris: JSON.stringify(['file:///Users/example/Dev/sample-project']),
        parent_conversation_id: rootId,
      },
    ]);

    const parsedRoot = parseAntigravitySessions(rootDb);
    assert.equal(parsedRoot.metadata.context_used_tokens, 353_000);
    assert.equal(parsedRoot.metadata.project, 'agentmonitor');
    assert.equal(parsedRoot.metadata.first_message, 'Build Antigravity Parity');
    assert.equal(parsedRoot.metadata.parent_session_id, null);
    assert.equal(parsedRoot.metadata.relationship_type, null);
    const importedRoot = parseAntigravityFile(rootDb);
    assert.ok(importedRoot.length > 0 && importedRoot.every(e => e.project === 'agentmonitor'));

    const parsedChild = parseAntigravitySessions(childDb);
    assert.equal(parsedChild.metadata.context_used_tokens, undefined, 'zero prompt tokens yield undefined occupancy');
    assert.equal(parsedChild.metadata.project, 'sample-project');
    assert.equal(parsedChild.metadata.first_message, 'Subagent preview fallback');
    assert.equal(parsedChild.metadata.parent_session_id, rootId);
    assert.equal(parsedChild.metadata.relationship_type, 'subagent');

    insertParsedSession(getDb(), parsedRoot, rootDb, 100, 'h-root');
    syncAntigravityLiveSession(getDb(), parsedRoot);
    const liveRoot = getLiveSession(rootId);
    assert.ok(liveRoot);
    assert.equal(liveRoot.context_used_tokens, 353_000);
    assert.equal(liveRoot.context_window_tokens, 1_048_576);
    assert.equal(liveRoot.context_pct, 34);

    syncAntigravityLiveSession(getDb(), parsedChild);
    const liveChild = getLiveSession(childId);
    assert.ok(liveChild);
    assert.equal(liveChild.parent_session_id, rootId);
    assert.equal(liveChild.relationship_type, 'subagent');
    assert.equal(liveChild.context_used_tokens, null);
    assert.equal(liveChild.context_window_tokens, null);
  });

  test('fails open cleanly when conversation_summaries.db is absent', () => {
    const home = path.join(tempDir, 'home-no-summary');
    const id = '33333333-3333-3333-3333-333333333333';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    writeConversationDb(dbPath, [
      { model: 'gemini-4-neon', sys: 100, inp: 400, out: 50, cached: 500 },
    ]);

    const parsed = parseAntigravitySessions(dbPath);
    assert.equal(parsed.metadata.context_used_tokens, 900);
    assert.equal(parsed.metadata.project, null);
    assert.equal(parsed.metadata.first_message, 'user input');
    assert.equal(parsed.metadata.parent_session_id, null);
    assert.equal(parsed.metadata.relationship_type, null);
  });

  test('re-syncs when conversation_summaries.db metadata updates without main .db changes', () => {
    const home = path.join(tempDir, 'home-resync');
    const id = '44444444-4444-4444-4444-444444444444';
    const dbPath = path.join(home, 'conversations', `${id}.db`);
    writeConversationDb(dbPath, [
      { model: 'gemini-4-neon', sys: 100, inp: 900, out: 50, cached: 0 },
    ]);

    const db = getDb();
    const first = syncAllAntigravityFiles(db, home, {});
    assert.equal(first.parsed, 1);
    const hashBefore = hashAntigravityDb(dbPath);

    writeSummaryDb(home, [{
      conversation_id: id,
      title: 'Delayed Title',
      workspace_uris: JSON.stringify(['file:///Users/example/Dev/delayed-proj']),
      parent_conversation_id: 'parent-999',
    }]);

    const hashAfter = hashAntigravityDb(dbPath);
    assert.notEqual(hashAfter, hashBefore);

    const second = syncAllAntigravityFiles(db, home, {});
    assert.equal(second.parsed, 1);
    const row = getLiveSession(id);
    assert.ok(row);
    assert.equal(row.project, 'delayed-proj');
    assert.equal(row.first_message, 'Delayed Title');
    assert.equal(row.parent_session_id, 'parent-999');
    assert.equal(row.relationship_type, 'subagent');
  });
});
