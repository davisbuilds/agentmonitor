import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { projectNameFromCwd } from '../src/util/project-identity.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-project-identity-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function repo(dir: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
// A linked worktree: a gitfile pointing at <repo>/.git/worktrees/<name>, whose
// commondir leads back to the repo's .git.
function worktree(repoDir: string, dir: string, name = path.basename(dir)): string {
  const admin = path.join(repoDir, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${admin}\n`);
  return dir;
}

const dev = path.join(root, 'Dev');
const app = repo(path.join(dev, 'app'));
const appIos = repo(path.join(dev, 'app-ios'));
fs.mkdirSync(path.join(app, 'src', 'deep'), { recursive: true });
fs.mkdirSync(path.join(dev, 'plain'), { recursive: true });

test('a directory inside a repo belongs to the repo', () => {
  assert.equal(projectNameFromCwd(app), 'app');
  assert.equal(projectNameFromCwd(path.join(app, 'src', 'deep')), 'app');
});

test('worktrees in a worktree area fold into their repo', () => {
  assert.equal(projectNameFromCwd(worktree(app, path.join(dev, '.worktrees', 'app-feature'))), 'app');
  assert.equal(projectNameFromCwd(worktree(app, path.join(app, '.claude', 'worktrees', 'agent-1'))), 'app');
  assert.equal(projectNameFromCwd(worktree(appIos, path.join(dev, '.tool-worktrees', 'app-ios-run-2026'))), 'app-ios');
});

test('a worktree outside a worktree area keeps its own name', () => {
  assert.equal(projectNameFromCwd(worktree(app, path.join(root, 'Vault', 'notes'))), 'notes');
});

test('a submodule is its own project', () => {
  const mod = path.join(app, 'vendor', 'lib');
  const admin = path.join(app, '.git', 'modules', 'lib');
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, '.git'), `gitdir: ${admin}\n`);
  assert.equal(projectNameFromCwd(mod), 'lib');
});

test('a directory outside any repo is named after itself', () => {
  assert.equal(projectNameFromCwd(dev), 'Dev');
  assert.equal(projectNameFromCwd(path.join(dev, 'plain')), 'plain');
});

test('removed worktrees still fold into their repo', () => {
  assert.equal(projectNameFromCwd(path.join(app, '.claude', 'worktrees', 'agent-gone')), 'app');
  // Even with the repo gone, an agent worktree is named after the repo's folder.
  assert.equal(projectNameFromCwd(path.join(root, 'moved-repo', '.claude', 'worktrees', 'agent-9')), 'moved-repo');
  assert.equal(projectNameFromCwd(path.join(dev, '.worktrees', 'app-old-task')), 'app');
  // The longest repo name the run directory starts with wins.
  assert.equal(projectNameFromCwd(path.join(dev, '.tool-worktrees', 'app-ios-code-coverage-app-ios-2026-05-13')), 'app-ios');
  assert.equal(projectNameFromCwd(path.join(dev, '.tool-worktrees', 'app-code-ci-app-2026-05-13', 'sub')), 'app');
});

test('a removed directory inside a repo that still exists belongs to it', () => {
  assert.equal(projectNameFromCwd(path.join(app, 'runs', 'gone', 'codex')), 'app');
});

test('anything else falls back to its own name', () => {
  assert.equal(projectNameFromCwd(path.join(root, 'gone', 'scratch')), 'scratch');
  assert.equal(projectNameFromCwd(path.join(dev, '.worktrees', 'unknown-task')), 'unknown-task');
  assert.equal(projectNameFromCwd(''), null);
  assert.equal(projectNameFromCwd(null), null);
});
