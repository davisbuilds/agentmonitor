import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-prune-git-cache-')));
const dbPath = path.join(directory, 'test.db');
process.env.AGENTMONITOR_DB_PATH = dbPath;
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const { acquireRuntimeOwnership } = await import('../src/runtime-ownership.js');

after(() => {
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

function cli(args: string[], exclusions: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf8',
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, AGENTMONITOR_DB_PATH: dbPath, AGENTMONITOR_GIT_EXCLUDE_DIRS: exclusions },
    timeout: 10_000,
  });
}

test('Git cache prune previews exact roots and guards an atomic, scoped apply', () => {
  initSchema();
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), dbPath);
  const container = path.join(directory, 'references');
  const excluded = path.join(container, 'repo');
  const trackerOnly = path.join(container, 'tracker');
  const commitsOnly = path.join(container, 'commits');
  const allowed = path.join(directory, 'references-active', 'repo');
  const now = '2026-01-01T00:00:00Z';
  const tracker = db.prepare("INSERT INTO git_repos (root, github_repo) VALUES (?, 'owner/repo')");
  for (const root of [excluded, trackerOnly, allowed]) tracker.run(root);
  const commit = db.prepare('INSERT INTO git_commits (repo_root, sha, authored_at, committed_at) VALUES (?, ?, ?, ?)');
  for (const root of [excluded, commitsOnly, allowed]) commit.run(root, 'one', now, now);
  db.prepare("INSERT INTO browsing_sessions (id, agent, cwd) VALUES ('kept-session', 'claude', ?)").run(excluded);
  db.prepare("INSERT INTO github_pull_request_commits VALUES ('owner/repo', 1, 'one', 'local')").run();

  const snapshot = () => [
    db.prepare('SELECT root FROM git_repos ORDER BY root').all(),
    db.prepare('SELECT repo_root, sha FROM git_commits ORDER BY repo_root').all(),
    db.prepare('SELECT id, cwd FROM browsing_sessions').all(),
    db.prepare('SELECT * FROM github_pull_request_commits').all(),
  ];
  const command = ['database', 'prune-git-cache', '--json'];
  const preview = () => {
    const result = cli(command, container);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const apply = (digest: string) => cli([...command, '--apply', '--expect-digest', digest], container);

  const before = snapshot();
  const initial = preview();
  assert.equal(initial.applied, false);
  assert.equal(initial.commits, 2);
  assert.match(initial.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(initial.repositories, [
    { root: commitsOnly, commits: 1, tracked: false },
    { root: excluded, commits: 1, tracked: true },
    { root: trackerOnly, commits: 0, tracked: true },
  ]);
  assert.deepEqual(snapshot(), before);
  assert.match(cli(command, '').stderr, /Set AGENTMONITOR_GIT_EXCLUDE_DIRS/);
  assert.match(cli([...command, '--apply'], container).stderr, /preview first/);

  db.prepare("UPDATE git_commits SET sha = 'two' WHERE repo_root = ?").run(excluded);
  const afterDrift = snapshot();
  const stale = apply(initial.digest);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /inventory changed/);
  assert.deepEqual(snapshot(), afterDrift);
  const fresh = preview();

  const lock = acquireRuntimeOwnership(dbPath);
  try {
    const occupied = apply(fresh.digest);
    assert.notEqual(occupied.status, 0);
    assert.match(occupied.stderr, /Stop the server/);
    assert.deepEqual(snapshot(), afterDrift);
  } finally {
    lock.release();
  }

  db.exec("CREATE TRIGGER fail_git_prune BEFORE DELETE ON git_repos BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;");
  const rolledBack = apply(fresh.digest);
  assert.notEqual(rolledBack.status, 0);
  assert.match(rolledBack.stderr, /fixture rollback/);
  assert.deepEqual(snapshot(), afterDrift);
  db.exec('DROP TRIGGER fail_git_prune');

  const result = apply(fresh.digest);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ...fresh, applied: true });
  assert.deepEqual(snapshot(), [[{ root: allowed }], [{ repo_root: allowed, sha: 'one' }], ...afterDrift.slice(2)]);
  assert.deepEqual(preview().repositories, []);
});
