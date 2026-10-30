import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Database } from 'better-sqlite3';

const run = promisify(execFile);

/** What one pass over the repositories found. */
export interface GitSyncReport {
  /** Repositories the stored sessions ran in. */
  repos: number;
  scanned: number;
  commits_seen: number;
  commits_removed: number;
  errors: number;
}

export interface GitSyncOptions {
  now?: Date;
}

const DAY_MS = 86_400_000;
/** A later pass rereads from this long before the last one, to pick up fetched commits and drop rewritten ones. */
const RESCAN_DAYS = 14;
/** A repository's first pass reaches back to its first session, but never further than this. */
const MAX_HISTORY_DAYS = 365;
/** Paths kept per commit: enough to see what it touched, bounded for a vendored import. */
const MAX_FILES = 500;
const GIT_TIMEOUT_MS = 60_000;

/**
 * The fields read per commit, separated so no subject or trailer can break a
 * record: \x1e starts a commit, \x1f separates fields, \x1d separates
 * co-authors. With `-z`, the header ends in NUL and `--name-only` follows it
 * with each changed path NUL-terminated and unquoted, so a path is kept as git
 * names it, spaces and non-ASCII included.
 */
const LOG_FORMAT = '%x1e%H%x1f%P%x1f%aI%x1f%cI%x1f%an%x1f%ae%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)';

interface CommitRecord {
  sha: string;
  authored_at: string;
  committed_at: string;
  author_name: string;
  author_email: string;
  subject: string;
  co_authors: string[];
  files: string[];
  is_merge: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * The repository a directory belongs to, a worktree resolved to its main
 * repository; null outside one. Asked again on every pass rather than cached:
 * an agent may run `git init` in a directory, inside another repository or
 * not, and the answer changes.
 */
async function repositoryRoot(cwd: string): Promise<string | null> {
  if (!fs.existsSync(cwd)) return null;
  try {
    const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return path.basename(common) === '.git' ? path.dirname(common) : common;
  } catch {
    return null;
  }
}

async function readCommits(root: string, since: Date): Promise<CommitRecord[]> {
  // --since stops walking at the first commit older than the cutoff, so a
  // backdated commit would hide the recent ones behind it, and the pass would
  // then remove them as rewritten. --since-as-filter (git 2.38) visits them all.
  // Merges are kept, flagged: a merged pull request leaves one. The output is
  // parsed, so no user config may add to it: log.showSignature would print
  // verification text between commits, and color would add escapes.
  const output = await git(root, ['log', '--all', '-z', '--no-show-signature', '--no-color', `--since-as-filter=${since.toISOString()}`, `--format=${LOG_FORMAT}`, '--name-only']);
  const commits = new Map<string, CommitRecord>();
  for (const record of output.split('\x1e').slice(1)) {
    const headerEnd = record.indexOf('\0');
    const header = headerEnd === -1 ? record : record.slice(0, headerEnd);
    const paths = headerEnd === -1 ? [] : record.slice(headerEnd + 1).replace(/^\n/, '').split('\0');
    const [sha, parents, authored, committed, authorName, authorEmail, subject, trailers] = header.split('\x1f');
    if (!sha || commits.has(sha)) continue;
    commits.set(sha, {
      sha,
      authored_at: new Date(authored).toISOString(),
      committed_at: new Date(committed).toISOString(),
      author_name: authorName,
      author_email: authorEmail,
      subject,
      co_authors: (trailers ?? '').split('\x1d').map(value => value.trim()).filter(Boolean),
      files: paths.filter(file => file.length > 0).slice(0, MAX_FILES),
      is_merge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  return [...commits.values()];
}

/**
 * Read commits from the repositories sessions ran in, into git_commits. A
 * repository's first pass reaches back to the day before its first session; a
 * later one rereads from RESCAN_DAYS before the last, and a commit stored in that window
 * that git no longer lists (rebased, amended, or on a deleted branch) is
 * removed, so rewritten history is not counted twice. Git runs as a child
 * process, so a pass never blocks the server.
 */
export async function syncGitActivity(db: Database, options: GitSyncOptions = {}): Promise<GitSyncReport> {
  const now = options.now ?? new Date();
  const report: GitSyncReport = { repos: 0, scanned: 0, commits_seen: 0, commits_removed: 0, errors: 0 };

  const firstSessionByRoot = new Map<string, number>();
  const directories = db.prepare(`
    SELECT cwd, MIN(started_at) AS first_started FROM browsing_sessions WHERE cwd IS NOT NULL GROUP BY cwd
  `).all() as Array<{ cwd: string; first_started: string | null }>;
  for (const row of directories) {
    const root = await repositoryRoot(row.cwd);
    if (!root) continue;
    const first = row.first_started ? Date.parse(row.first_started) : Number.NaN;
    const known = firstSessionByRoot.get(root);
    firstSessionByRoot.set(root, Number.isNaN(first) ? known ?? Number.NaN : Math.min(known ?? first, first));
  }
  report.repos = firstSessionByRoot.size;

  const lastScan = db.prepare('SELECT last_scanned_at FROM git_repos WHERE root = ?');
  const recordScan = db.prepare(`
    INSERT INTO git_repos (root, last_scanned_at, last_error) VALUES (?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      last_scanned_at = COALESCE(excluded.last_scanned_at, git_repos.last_scanned_at),
      last_error = excluded.last_error
  `);
  const upsert = db.prepare(`
    INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, author_name, author_email, subject, co_authors_json, files_json, is_merge)
    VALUES (@repo_root, @sha, @authored_at, @committed_at, @author_name, @author_email, @subject, @co_authors_json, @files_json, @is_merge)
    ON CONFLICT(repo_root, sha) DO UPDATE SET
      authored_at = excluded.authored_at, committed_at = excluded.committed_at,
      author_name = excluded.author_name, author_email = excluded.author_email, subject = excluded.subject,
      co_authors_json = excluded.co_authors_json, files_json = excluded.files_json, is_merge = excluded.is_merge
  `);
  const storedInWindow = db.prepare('SELECT sha FROM git_commits WHERE repo_root = ? AND committed_at >= ?');
  const remove = db.prepare('DELETE FROM git_commits WHERE repo_root = ? AND sha = ?');

  for (const [root, firstSession] of firstSessionByRoot) {
    const floor = now.getTime() - MAX_HISTORY_DAYS * DAY_MS;
    const scanned = (lastScan.get(root) as { last_scanned_at: string | null } | undefined)?.last_scanned_at;
    // A reread overlaps the last read by RESCAN_DAYS, however long ago it was,
    // so downtime never leaves a gap.
    const since = new Date(Math.max(floor, scanned
      ? Math.min(now.getTime(), Date.parse(scanned)) - RESCAN_DAYS * DAY_MS
      : Number.isNaN(firstSession) ? floor : firstSession - DAY_MS));
    let commits: CommitRecord[];
    try {
      commits = await readCommits(root, since);
    } catch (err) {
      report.errors += 1;
      recordScan.run(root, null, err instanceof Error ? err.message.slice(0, 500) : String(err));
      continue;
    }
    db.transaction(() => {
      const seen = new Set<string>();
      for (const commit of commits) {
        seen.add(commit.sha);
        upsert.run({
          repo_root: root,
          sha: commit.sha,
          authored_at: commit.authored_at,
          committed_at: commit.committed_at,
          author_name: commit.author_name,
          author_email: commit.author_email,
          subject: commit.subject,
          co_authors_json: JSON.stringify(commit.co_authors),
          files_json: JSON.stringify(commit.files),
          is_merge: commit.is_merge ? 1 : 0,
        });
      }
      for (const { sha } of storedInWindow.all(root, since.toISOString()) as Array<{ sha: string }>) {
        if (seen.has(sha)) continue;
        remove.run(root, sha);
        report.commits_removed += 1;
      }
      recordScan.run(root, now.toISOString(), null);
    })();
    report.scanned += 1;
    report.commits_seen += commits.length;
  }
  return report;
}
