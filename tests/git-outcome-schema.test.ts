import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-git-outcome-schema-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'v28.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const columns = (table: string) =>
  new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));

test('v29 adds pull request size, membership and commit landing to a v28 store, keeping its rows', () => {
  const db = getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  // The git tables as v28 left them.
  db.exec(`
    CREATE TABLE git_commits (
      repo_root TEXT NOT NULL, sha TEXT NOT NULL, authored_at TEXT NOT NULL, committed_at TEXT NOT NULL,
      author_name TEXT, author_email TEXT, subject TEXT,
      co_authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(co_authors_json)),
      files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_json)),
      is_merge INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repo_root, sha)
    );
    INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, subject)
      VALUES ('/repo', 'abc', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'feat: kept');
    CREATE TABLE github_pull_requests (
      repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT, merged_at TEXT, created_at TEXT,
      checked_at TEXT NOT NULL, PRIMARY KEY (repo, number)
    );
    INSERT INTO github_pull_requests (repo, number, state, checked_at) VALUES ('owner/repo', 7, 'MERGED', '2026-10-02T00:00:00Z');
  `);
  db.pragma('user_version = 28');

  initSchema();

  for (const column of ['parents_json', 'landing']) assert.ok(columns('git_commits').has(column), column);
  for (const column of ['additions', 'deletions', 'changed_files', 'commit_count', 'author_is_bot', 'details_at']) {
    assert.ok(columns('github_pull_requests').has(column), column);
  }
  assert.deepEqual([...columns('github_pull_request_commits')].sort(), ['number', 'repo', 'sha', 'source']);
  assert.ok(columns('github_pull_request_search').has('window_start'));

  assert.deepEqual(db.prepare('SELECT subject, parents_json, landing FROM git_commits').get(),
    { subject: 'feat: kept', parents_json: '[]', landing: null });
  assert.deepEqual(db.prepare('SELECT state, additions FROM github_pull_requests').get(), { state: 'MERGED', additions: null });
  assert.throws(() => db.prepare("UPDATE git_commits SET landing = 'elsewhere'").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO github_pull_request_commits VALUES ('owner/repo', 7, 'abc', 'guess')").run(), /CHECK/);
  assert.equal(db.pragma('user_version', { simple: true }), 29);
});
