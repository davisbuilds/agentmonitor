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
