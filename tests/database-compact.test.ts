import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-database-compact-'));
const dbPath = path.join(root, 'agentmonitor.db');
const backupDir = path.join(root, 'private-backups');
process.env.AGENTMONITOR_DB_PATH = dbPath;

class CaptureStream extends Writable {
  output = '';
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

async function runCli(args: string[]) {
  const { main } = await import('../src/cli.js');
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await main(['/usr/local/bin/node', '/repo/dist/cli.js', '--db-path', dbPath, ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

// A store with both kinds of reclaimable space: free pages from dropped data,
// and dead search-index entries from repeated delete-and-reinsert re-syncs
// (automerge off reproduces the large old segments FTS5 never merges on its own).
async function buildFixture(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '.runtime.lock']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const connection = await import('../src/db/connection.js');
  const schema = await import('../src/db/schema.js');
  schema.initSchema();
  const db = connection.getDb();
  assert.equal(db.name, dbPath);
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)");
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('crisismerge', 64)");
  const insert = db.prepare('INSERT INTO messages (session_id, ordinal, role, content) VALUES (?, ?, ?, ?)');
  for (let pass = 0; pass < 30; pass++) {
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run('fixture');
      for (let i = 0; i < 100; i++) {
        insert.run('fixture', i, 'user', Array.from({ length: 40 }, (_, j) => `${WORDS[(i + j) % 10]}${(i * 7 + j) % 97}`).join(' '));
      }
    })();
  }
  db.exec("CREATE TABLE filler (blob TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO filler SELECT hex(randomblob(512)) FROM n; DROP TABLE filler;");
  connection.closeDb();
}

function counts(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      messages: (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c,
      alpha3: (db.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'alpha3'").get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

before(() => {
  fs.mkdirSync(backupDir, { mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
});

beforeEach(async () => {
  for (const name of fs.readdirSync(backupDir)) fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
  await buildFixture();
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('compact backs up the store, then reclaims free pages and dead index entries', async () => {
  const expected = counts(dbPath);
  const backup = path.join(backupDir, 'before-compact.db');

  const result = await runCli(['database', 'compact', '--backup', backup, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.quick_check, 'ok');
  assert.ok(payload.before.free_pages > 0, 'the fixture has free pages');
  assert.equal(payload.after.free_pages, 0);
  assert.ok(payload.search_merge_steps > 1);
  assert.ok(payload.after.search_index_bytes * 3 <= payload.before.search_index_bytes,
    `search index ${payload.before.search_index_bytes} -> ${payload.after.search_index_bytes}`);
  assert.ok(payload.after.database_bytes < payload.before.database_bytes);
  assert.equal(payload.after.database_bytes, fs.statSync(dbPath).size);
  assert.equal(payload.after.wal_bytes, 0);
  assert.deepEqual(counts(dbPath), expected);
  // The backup is the store as it was, validated and closed.
  assert.equal(payload.backup, path.join(fs.realpathSync(backupDir), 'before-compact.db'));
  assert.deepEqual(counts(backup), expected);
  assert.equal(fs.statSync(backup).size, payload.before.database_bytes);
});

test('compact refuses without a backup path and leaves the store alone', async () => {
  const size = fs.statSync(dbPath).size;
  const result = await runCli(['database', 'compact']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--backup/);
  assert.equal(fs.statSync(dbPath).size, size);
});

test('compact refuses while a server owns the store', async () => {
  const { acquireRuntimeOwnership } = await import('../src/runtime-ownership.js');
  const size = fs.statSync(dbPath).size;
  const ownership = acquireRuntimeOwnership(dbPath);
  try {
    const result = await runCli(['database', 'compact', '--backup', path.join(backupDir, 'owned.db')]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Stop the server before compacting/);
  } finally {
    ownership.release();
  }
  assert.equal(fs.statSync(dbPath).size, size);
  assert.deepEqual(fs.readdirSync(backupDir), []);
});

test('compact refuses when the volume lacks room for the backup and the rewrite', async () => {
  const { compactDatabase, DatabaseCompactPolicyError } = await import('../src/db/compact.js');
  const size = fs.statSync(dbPath).size;
  await assert.rejects(
    compactDatabase({ source: dbPath, backup: path.join(backupDir, 'no-room.db'), availableBytes: () => size * 2 }),
    (error: unknown) => error instanceof DatabaseCompactPolicyError && /free space/.test(error.message),
  );
  assert.equal(fs.statSync(dbPath).size, size);
  assert.deepEqual(fs.readdirSync(backupDir), []);
});

test('compact keeps an existing backup and leaves the store alone', async () => {
  const existing = path.join(backupDir, 'existing.db');
  fs.writeFileSync(existing, 'keep me', { mode: 0o600 });
  const size = fs.statSync(dbPath).size;
  const result = await runCli(['database', 'compact', '--backup', existing]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /already exists/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me');
  assert.equal(fs.statSync(dbPath).size, size);
});

test('storage reports the sizes compact acts on', async () => {
  const result = await runCli(['database', 'storage', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.database_bytes, fs.statSync(dbPath).size);
  assert.ok(report.free_pages > 0);
  assert.equal(report.free_bytes, report.free_pages * report.page_size);
  assert.ok(report.search_index_bytes > 0);
});
