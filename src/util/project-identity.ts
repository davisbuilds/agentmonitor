import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical project identity: the git repository a working directory belongs
 * to, named after the repository root. A linked worktree in a worktree area
 * (`.worktrees/`, `*-worktrees/`, `.claude/worktrees/`, `.codex/worktrees/`)
 * folds into its main repository; a worktree elsewhere, or a submodule, keeps
 * its own name. A directory outside any repository is named after itself.
 *
 * Transcripts outlive their directories, so a removed path is still resolved
 * where its shape allows: an agent worktree folds into the repository above
 * it, a run directory in a worktree area folds into the longest sibling
 * repository name it starts with, and a removed directory inside a repository
 * that still exists belongs to that repository. Anything else keeps its own
 * name, as before.
 */

// Resolution reads the filesystem, and an import resolves the same directories
// many times over. Entries expire so a long-running server notices a worktree
// path removed and recreated, or repointed to another repository.
const CACHE_TTL_MS = 30_000;
const resolved = new Map<string, { name: string | null; at: number }>();
const reposByParent = new Map<string, { repos: string[]; at: number }>();

function fresh<T extends { at: number }>(entry: T | undefined): T | undefined {
  return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry : undefined;
}

function isWorktreeContainer(dir: string): boolean {
  const name = path.basename(dir);
  return name === '.worktrees' || name.endsWith('-worktrees');
}

function inWorktreeArea(dir: string): boolean {
  return isWorktreeContainer(path.dirname(dir))
    || /\/\.(claude|codex)\/worktrees\//.test(`${dir}/`);
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/** The main repository root a gitfile's worktree belongs to, or null. */
function worktreeMainRoot(gitfile: string): string | null {
  let gitdir: string;
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitfile, 'utf8'));
    if (!match) return null;
    gitdir = path.resolve(path.dirname(gitfile), match[1].trim());
  } catch {
    return null;
  }
  let commondir: string;
  try {
    commondir = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    return null; // a submodule: no commondir
  }
  return path.basename(commondir) === '.git' ? path.dirname(commondir) : null;
}

/** The repository root containing an existing directory, or null. */
function gitRoot(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const marker = statOrNull(path.join(current, '.git'));
    if (marker?.isDirectory()) return current;
    if (marker?.isFile()) {
      const main = inWorktreeArea(current) ? worktreeMainRoot(path.join(current, '.git')) : null;
      return main ?? current;
    }
    if (path.dirname(current) === current) return null;
  }
}

/** Repository directories directly under `parent`, longest name first. */
function siblingRepos(parent: string): string[] {
  let repos = fresh(reposByParent.get(parent))?.repos;
  if (!repos) {
    try {
      repos = fs.readdirSync(parent, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && statOrNull(path.join(parent, entry.name, '.git')) !== null)
        .map(entry => entry.name)
        .sort((a, b) => b.length - a.length);
    } catch {
      repos = [];
    }
    reposByParent.set(parent, { repos, at: Date.now() });
  }
  return repos;
}

function resolveRoot(dir: string): string {
  if (statOrNull(dir)?.isDirectory()) return gitRoot(dir) ?? dir;

  const agentWorktree = /^(.*?)\/\.(claude|codex)\/worktrees\/[^/]+/.exec(dir);
  if (agentWorktree?.[1]) return resolveRoot(agentWorktree[1]);

  for (let current = dir; path.dirname(current) !== current; current = path.dirname(current)) {
    const container = path.dirname(current);
    if (!isWorktreeContainer(container)) continue;
    const run = path.basename(current);
    const parent = path.dirname(container);
    const repo = siblingRepos(parent).find(name => run === name || run.startsWith(`${name}-`));
    if (repo) return path.join(parent, repo);
    break;
  }

  for (let current = path.dirname(dir); path.dirname(current) !== current; current = path.dirname(current)) {
    if (!statOrNull(current)?.isDirectory()) continue;
    return gitRoot(current) ?? dir;
  }
  return dir;
}

/** The project a working directory belongs to, or null without one. */
export function projectNameFromCwd(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;
  const dir = path.resolve(trimmed);
  const cached = fresh(resolved.get(dir));
  if (cached) return cached.name;
  const name = path.basename(resolveRoot(dir)) || null;
  resolved.set(dir, { name, at: Date.now() });
  return name;
}
