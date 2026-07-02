import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { syncAllAntigravityFiles as syncAllAntigravityFilesFn } from '../src/watcher/index.js';
import { hashAntigravityDb } from '../src/watcher/index.js';

// --- minimal protobuf encoder (deterministic fixtures) ---
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
const buf = (a: number[]) => Buffer.from(a);

// Full gemini_coder.Step: type(1), status(4), metadata(5), <oneof>(payload)
const step = (type: number, oneof: number) =>
  buf([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, [...vField(1, 1)])]);
// CortexStepMetadata column: field1.field1 = unix seconds
const meta = (secs: number) => buf(lField(1, [...vField(1, secs)]));

// Write a conversation DB under <home>/conversations/<uuid>.db (matches importer scope).
function buildFixture(home: string, uuid: string): string {
  const dir = path.join(home, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${uuid}.db`);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB);');
  const ins = db.prepare('INSERT INTO steps(idx,step_type,status,step_payload,metadata) VALUES (?,?,?,?,?)');
  ins.run(0, 14, 3, step(14, 19), meta(1782000000)); // oneof 19 = user_input
  ins.run(1, 28, 3, step(28, 28), meta(1782000005)); // oneof 28 = run_command (tool)
  ins.run(2, 999, 3, step(999, 9998), meta(1782000010)); // unknown oneof → generic assistant
  db.close();
  return dbPath;
}

let tempDir = '';
let home = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let syncAllAntigravityFiles: typeof syncAllAntigravityFilesFn;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-sync-'));
  home = path.join(tempDir, 'antigravity-cli');
  fs.mkdirSync(path.join(tempDir, 'db'), { recursive: true });
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'db', 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  ({ syncAllAntigravityFiles } = await import('../src/watcher/index.js'));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('syncAllAntigravityFiles: projects a browsable, trace-quality-visible session', () => {
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  buildFixture(home, uuid);
  const db = getDb();

  const stats = syncAllAntigravityFiles(db, home, { force: true });
  assert.equal(stats.total, 1);
  assert.equal(stats.parsed, 1);

  // (1) browser row, agent-filterable, with integration_mode/fidelity set (projector).
  const bs = db.prepare('SELECT agent, integration_mode, fidelity FROM browsing_sessions WHERE id = ?')
    .get(uuid) as { agent: string; integration_mode: string | null; fidelity: string | null } | undefined;
  assert.ok(bs, 'browsing_sessions row exists');
  assert.equal(bs!.agent, 'antigravity');
  assert.ok(bs!.integration_mode, 'integration_mode is non-null');
  assert.ok(bs!.fidelity, 'fidelity is non-null');

  // (2) messages (search/analytics) present.
  const msgs = db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(uuid) as { c: number };
  assert.ok(msgs.c > 0, 'messages projected');

  // (3) projected stream (trace-quality) present.
  const turns = db.prepare('SELECT COUNT(*) c FROM session_turns WHERE session_id = ?').get(uuid) as { c: number };
  const items = db.prepare('SELECT COUNT(*) c FROM session_items WHERE session_id = ?').get(uuid) as { c: number };
  assert.ok(turns.c > 0, 'session_turns projected');
  assert.ok(items.c > 0, 'session_items projected');
});

test('hashAntigravityDb: change token folds in WAL/SHM sidecars (catches committed-in-WAL steps)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-hash-'));
  const dbPath = path.join(dir, 'conv.db');
  fs.writeFileSync(dbPath, Buffer.from('main-db-page-bytes'));

  const base = hashAntigravityDb(dbPath);
  assert.equal(hashAntigravityDb(dbPath), base, 'stable when nothing changes');

  // A still-open DB commits new steps into the WAL sidecar; the main file is unchanged.
  fs.writeFileSync(dbPath + '-wal', Buffer.from('wal-frame-1'));
  const withWal = hashAntigravityDb(dbPath);
  assert.notEqual(withWal, base, 'a new/changed WAL flips the token even though main .db is identical');

  fs.writeFileSync(dbPath + '-wal', Buffer.from('wal-frame-1+2'));
  const grownWal = hashAntigravityDb(dbPath);
  assert.notEqual(grownWal, withWal, 'more committed WAL frames flip the token again');

  fs.writeFileSync(dbPath + '-shm', Buffer.from('shm-index'));
  assert.notEqual(hashAntigravityDb(dbPath), grownWal, 'SHM state also participates');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('syncAllAntigravityFiles: is idempotent (hash-guarded via watched_files)', () => {
  const db = getDb();
  const second = syncAllAntigravityFiles(db, home, {});
  assert.equal(second.total, 1);
  assert.equal(second.parsed, 0, 'unchanged file skipped on re-sync');
  assert.equal(second.skipped, 1);
});
