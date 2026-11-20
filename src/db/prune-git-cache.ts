import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { isExcludedGitDirectory } from '../git/exclusions.js';
import { acquireRuntimeOwnership } from '../runtime-ownership.js';

interface CachedRepository {
  root: string;
  commits: number;
  tracked: boolean;
}

export interface GitCachePruneResult {
  repositories: CachedRepository[];
  commits: number;
  digest: string;
  applied: boolean;
}

function gitCacheInventory(db: Database.Database, dbPath: string, excludedDirs: readonly string[]) {
  // Include roots that have only a tracker or only commits in an older store.
  const roots = db.prepare(`
    SELECT root, MAX(tracked) AS tracked FROM (
      SELECT root, 1 AS tracked FROM git_repos
      UNION ALL
      SELECT DISTINCT repo_root, 0 FROM git_commits
    ) GROUP BY root ORDER BY root
  `).all() as Array<{ root: string; tracked: number }>;
  const commitShas = db.prepare('SELECT sha FROM git_commits WHERE repo_root = ? ORDER BY sha');
  const hash = createHash('sha256').update(JSON.stringify(['git-cache-prune-v1', dbPath]) + '\n');
  const repositories: CachedRepository[] = [];
  for (const { root, tracked } of roots) {
    if (!isExcludedGitDirectory(root, excludedDirs)) continue;
    hash.update(JSON.stringify([root, tracked]) + '\n');
    let commits = 0;
    for (const { sha } of commitShas.iterate(root) as Iterable<{ sha: string }>) {
      hash.update(JSON.stringify(sha) + '\n');
      commits++;
    }
    repositories.push({ root, commits, tracked: tracked === 1 });
  }
  return { repositories, commits: repositories.reduce((sum, repo) => sum + repo.commits, 0), digest: hash.digest('hex') };
}

export function pruneGitCache(options: {
  dbPath: string;
  excludedDirs: readonly string[];
  expectDigest?: string;
}): GitCachePruneResult {
  const applied = options.expectDigest !== undefined;
  const dbPath = realpathSync.native(options.dbPath);
  const ownership = applied ? acquireRuntimeOwnership(dbPath) : undefined;
  try {
    const db = new Database(dbPath, { fileMustExist: true, readonly: !applied, timeout: 30_000 });
    try {
      const run = db.transaction(() => {
        const plan = gitCacheInventory(db, dbPath, options.excludedDirs);
        if (applied) {
          if (plan.digest !== options.expectDigest) throw new Error('Git cache inventory changed; preview again');
          const deleteCommits = db.prepare('DELETE FROM git_commits WHERE repo_root = ?');
          const deleteRepo = db.prepare('DELETE FROM git_repos WHERE root = ?');
          for (const { root } of plan.repositories) {
            deleteCommits.run(root);
            deleteRepo.run(root);
          }
        }
        return { ...plan, applied };
      });
      return applied ? run.immediate() : run();
    } finally {
      db.close();
    }
  } finally {
    ownership?.release();
  }
}
