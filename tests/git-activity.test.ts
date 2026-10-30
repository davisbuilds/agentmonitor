import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-git-activity-')));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
// The fixture repos and the reads under test see no user or system git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const { syncGitActivity } = await import('../src/git/activity.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

const repo = path.join(tempDir, 'alpha');
const worktree = path.join(tempDir, 'alpha-fix');
const git = (cwd: string, args: string[], at?: string) => execFileSync('git', args, {
  cwd,
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com',
    ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
  },
}).toString().trim();
const commit = (cwd: string, file: string, message: string, at: string) => {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message], at);
  return git(cwd, ['rev-parse', 'HEAD']);
};

fs.mkdirSync(repo);
git(repo, ['init', '-q', '-b', 'main']);
// Within the history cap but before any session here: the first scan does not reach it.
commit(repo, 'old.txt', 'chore: before the sessions', '2026-01-15T00:00:00Z');
const first = commit(repo, 'a.ts', 'feat: add a', '2026-03-02T10:00:00Z');
const second = commit(repo, 'AGENTS.md', 'docs: agent rules\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', '2026-03-03T10:00:00-05:00');
git(repo, ['worktree', 'add', '-q', '-b', 'fix', worktree]);
const onBranch = commit(worktree, 'b.ts', 'fix: in the worktree', '2026-03-04T10:00:00Z');

const session = db.prepare("INSERT INTO browsing_sessions (id, agent, cwd, started_at, message_count, user_message_count) VALUES (?, 'claude', ?, ?, 1, 1)");
session.run('s-repo', repo, '2026-03-02T09:00:00Z');
session.run('s-worktree', worktree, '2026-03-04T09:00:00Z');
session.run('s-scratch', tempDir, '2026-03-02T09:00:00Z');
session.run('s-gone', path.join(tempDir, 'deleted'), '2026-03-02T09:00:00Z');

const commits = () => db.prepare(`SELECT repo_root, sha, authored_at, subject, co_authors_json, files_json FROM git_commits ORDER BY authored_at`).all() as Array<{
  repo_root: string; sha: string; authored_at: string; subject: string; co_authors_json: string; files_json: string;
}>;

test('commits come from the repositories sessions ran in, a worktree folded into its repository', async () => {
  const report = await syncGitActivity(db, { now: new Date('2026-03-10T00:00:00Z') });
  assert.deepEqual([report.repos, report.scanned, report.errors], [1, 1, 0]);
  const rows = commits();
  assert.deepEqual(rows.map(row => [row.repo_root, row.sha]), [[repo, first], [repo, second], [repo, onBranch]]);
  assert.deepEqual(rows.map(row => row.subject), ['feat: add a', 'docs: agent rules', 'fix: in the worktree']);
  assert.equal(rows[1].authored_at, '2026-03-03T15:00:00.000Z', 'times are stored in UTC');
  assert.deepEqual(JSON.parse(rows[1].co_authors_json), ['Claude Opus 5.5 <noreply@anthropic.com>']);
  assert.deepEqual(JSON.parse(rows[1].files_json), ['AGENTS.md']);
  assert.deepEqual(JSON.parse(rows[0].co_authors_json), []);
});

test('a commit rewritten since the last scan is replaced, not counted twice', async () => {
  git(worktree, ['commit', '-q', '--amend', '-m', 'fix: in the worktree, reworded'], '2026-03-09T10:00:00Z');
  const amended = git(worktree, ['rev-parse', 'HEAD']);
  const report = await syncGitActivity(db, { now: new Date('2026-03-12T00:00:00Z') });
  assert.equal(report.commits_removed, 1);
  assert.deepEqual(commits().map(row => row.sha), [first, second, amended]);
});

/** A repository of its own with one session in it, for a scenario that must not see the others' commits. */
function freshRepository(name: string, sessionStarted: string): string {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  session.run(`s-${name}`, dir, sessionStarted);
  return dir;
}
const shasIn = (root: string) => (db.prepare('SELECT sha FROM git_commits WHERE repo_root = ? ORDER BY authored_at').all(root) as Array<{ sha: string }>)
  .map(row => row.sha);

test('a read after downtime reaches back to the last one, not only the last two weeks', async () => {
  const dir = freshRepository('gamma', '2026-03-01T09:00:00Z');
  const before = commit(dir, 'a.txt', 'feat: before', '2026-03-01T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  const during = commit(dir, 'b.txt', 'feat: while the server was down', '2026-03-05T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-04-01T00:00:00Z') });
  assert.deepEqual(shasIn(dir), [before, during]);
});

test('a directory that becomes a repository is read once it does', async () => {
  const dir = path.join(tempDir, 'delta');
  fs.mkdirSync(dir);
  session.run('s-delta', dir, '2026-03-01T09:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  git(dir, ['init', '-q', '-b', 'main']);
  const first = commit(dir, 'a.txt', 'feat: first', '2026-03-02T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-03T00:00:00Z') });
  assert.deepEqual(shasIn(dir), [first]);
});

test('a backdated commit does not hide a recent one behind it from the reread', async () => {
  const dir = freshRepository('epsilon', '2026-04-01T09:00:00Z');
  const recent = commit(dir, 'a.txt', 'feat: recent', '2026-04-01T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-04-02T00:00:00Z') });
  // A child whose committer date is older than the reread window.
  commit(dir, 'b.txt', 'chore: backdated', '2026-01-01T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-04-03T00:00:00Z') });
  assert.ok(shasIn(dir).includes(recent), 'the recent commit is still reachable, so it stays');
});

test('a repository created inside another is read on its own once it exists', async () => {
  const parent = freshRepository('zeta', '2026-03-01T09:00:00Z');
  commit(parent, 'top.txt', 'feat: parent', '2026-03-01T10:00:00Z');
  const nested = path.join(parent, 'nested');
  fs.mkdirSync(nested);
  session.run('s-zeta-nested', nested, '2026-03-01T09:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  git(nested, ['init', '-q', '-b', 'main']);
  const own = commit(nested, 'a.txt', 'feat: nested', '2026-03-02T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-03T00:00:00Z') });
  assert.deepEqual(shasIn(nested), [own]);
});

test('changed paths are stored as git names them, unquoted and untrimmed', async () => {
  const dir = freshRepository('eta', '2026-03-01T09:00:00Z');
  for (const name of ['日本.ts', ' spaced .ts']) fs.writeFileSync(path.join(dir, name), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'feat: odd names'], '2026-03-01T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  const files = JSON.parse((db.prepare('SELECT files_json FROM git_commits WHERE repo_root = ?').get(dir) as { files_json: string }).files_json);
  assert.deepEqual([...files].sort(), [' spaced .ts', '日本.ts']);
});

test('merge commits are kept, flagged, so a merged pull request can be found', async () => {
  const dir = freshRepository('theta', '2026-03-01T09:00:00Z');
  commit(dir, 'a.txt', 'feat: base', '2026-03-01T10:00:00Z');
  git(dir, ['checkout', '-q', '-b', 'feature']);
  const work = commit(dir, 'b.txt', 'feat: the change', '2026-03-01T11:00:00Z');
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from example/feature', 'feature'], '2026-03-01T12:00:00Z');
  const merge = git(dir, ['rev-parse', 'HEAD']);
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  const flagged = Object.fromEntries((db.prepare('SELECT sha, is_merge FROM git_commits WHERE repo_root = ?').all(dir) as Array<{ sha: string; is_merge: number }>)
    .map(row => [row.sha, row.is_merge]));
  assert.equal(flagged[merge], 1);
  assert.equal(flagged[work], 0);
});

test('signature verification in the user\'s git config does not leak into stored paths', async () => {
  const dir = freshRepository('iota', '2026-03-01T09:00:00Z');
  const key = path.join(tempDir, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  git(dir, ['config', 'gpg.format', 'ssh']);
  git(dir, ['config', 'user.signingkey', key]);
  git(dir, ['config', 'log.showSignature', 'true']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-S', '-m', 'feat: signed'], '2026-03-01T10:00:00Z');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'y\n');
  git(dir, ['add', 'b.txt']);
  git(dir, ['commit', '-q', '-S', '-m', 'feat: signed again'], '2026-03-01T11:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  const rows = db.prepare('SELECT subject, files_json FROM git_commits WHERE repo_root = ? ORDER BY authored_at').all(dir) as Array<{ subject: string; files_json: string }>;
  assert.deepEqual(rows.map(row => [row.subject, JSON.parse(row.files_json)]), [['feat: signed', ['a.txt']], ['feat: signed again', ['b.txt']]]);
});

test('a session found later, older than any read so far, extends the next read back to it', async () => {
  const dir = freshRepository('kappa', '2026-04-01T09:00:00Z');
  const older = commit(dir, 'a.txt', 'feat: from an older session', '2026-03-01T10:00:00Z');
  const recent = commit(dir, 'b.txt', 'feat: recent', '2026-04-01T10:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-04-02T00:00:00Z') });
  assert.deepEqual(shasIn(dir), [recent], 'the first read reaches back only to the day before its first session');
  // A forced session sync restores a March session in the same repository.
  session.run('s-kappa-march', dir, '2026-03-01T09:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-04-03T00:00:00Z') });
  assert.deepEqual(shasIn(dir), [older, recent]);
});

test('stashes and notes are not anyone\'s commits', async () => {
  const dir = freshRepository('lambda', '2026-03-01T09:00:00Z');
  const real = commit(dir, 'a.txt', 'feat: real work', '2026-03-01T10:00:00Z');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  git(dir, ['stash', '-q'], '2026-03-01T11:00:00Z');
  git(dir, ['notes', 'add', '-m', 'a note', real], '2026-03-01T12:00:00Z');
  await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  assert.deepEqual(shasIn(dir), [real]);
});

test('a repository with no commits yet reads as empty, not as an error', async () => {
  freshRepository('mu', '2026-03-01T09:00:00Z');
  const report = await syncGitActivity(db, { now: new Date('2026-03-02T00:00:00Z') });
  assert.equal(report.errors, 0);
});
