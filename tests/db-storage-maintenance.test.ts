import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-storage-maintenance-'));
process.env.AGENTMONITOR_DB_PATH = path.join(dir, 'test.db');
let closeDb: (() => void) | undefined;
let db: Database.Database;
let storage: typeof import('../src/db/storage.js');

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

function messageContent(i: number): string {
  return Array.from({ length: 40 }, (_, j) => `${WORDS[(i + j) % WORDS.length]}${(i * 7 + j) % 97}`).join(' ');
}

// The pre-incremental re-sync deleted a session's messages and inserted them
// again on every append. Each pass leaves the old postings in the index as
// dead entries that only a merge into the older segments removes. On a real
// store those sit in large old segments FTS5's incremental merges never reach;
// a small fixture reproduces that by turning automerge off and letting
// segments pile up before a crisis merge.
function rewriteSession(times: number): void {
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)");
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('crisismerge', 64)");
  const insert = db.prepare('INSERT INTO messages (session_id, ordinal, role, content) VALUES (?, ?, ?, ?)');
  for (let pass = 0; pass < times; pass++) {
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run('bloated');
      for (let i = 0; i < 100; i++) insert.run('bloated', i, 'user', messageContent(i));
    })();
  }
}

function matches(term: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH ?').get(term) as { c: number }).c;
}

before(async () => {
  const connection = await import('../src/db/connection.js');
  closeDb = connection.closeDb;
  const schema = await import('../src/db/schema.js');
  schema.initSchema();
  db = connection.getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  storage = await import('../src/db/storage.js');
});

after(() => {
  closeDb?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stepwise merge reclaims dead search-index entries without changing results', async () => {
  rewriteSession(30);
  const expected = { alpha: matches('alpha3'), golf: matches('golf50'), absent: matches('zulu') };
  const bloated = storage.searchIndexBytes(db);
  let pauses = 0;

  const result = await storage.mergeSearchIndex(db, { pages: 4, pause: async () => { pauses++; } });

  const merged = storage.searchIndexBytes(db);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  const rebuilt = storage.searchIndexBytes(db);
  // The merge reaches the size of an index built from scratch, and the fixture
  // was bloated enough for that to mean something.
  assert.ok(merged <= rebuilt * 1.25, `merged ${merged} bytes, rebuilt ${rebuilt}`);
  assert.ok(bloated >= merged * 3, `bloated ${bloated} bytes, merged ${merged}`);
  assert.equal(result.completed, true);
  assert.ok(result.steps > 1, `steps ${result.steps}`);
  assert.equal(pauses, result.steps - 1);
  assert.deepEqual({ alpha: matches('alpha3'), golf: matches('golf50'), absent: matches('zulu') }, expected);
  assert.ok(expected.alpha > 0 && expected.golf > 0);

  // Once clean, a run finds nothing to do.
  assert.deepEqual(await storage.mergeSearchIndex(db), { steps: 1, completed: true });
});

test('a stepwise merge stops between steps when asked', async () => {
  rewriteSession(30);
  let checks = 0;
  const result = await storage.mergeSearchIndex(db, { pages: 1, shouldStop: () => ++checks > 2 });
  assert.deepEqual(result, { steps: 2, completed: false });

  rewriteSession(30);
  assert.deepEqual(await storage.mergeSearchIndex(db, { pages: 1, maxSteps: 3 }), { steps: 3, completed: false });
});
