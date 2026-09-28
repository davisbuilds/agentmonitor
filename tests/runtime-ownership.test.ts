import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  acquireRuntimeOwnership,
  readRuntimeOwner,
  RuntimeOwnershipError,
} from '../src/runtime-ownership.js';
import { staleServerWarning } from '../src/cli/stale-server.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-runtime-owner-'));
}

test('a live process cannot acquire the same database twice', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'agentmonitor.db');
  const owner = acquireRuntimeOwnership(dbPath);

  try {
    assert.throws(
      () => acquireRuntimeOwnership(dbPath),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeOwnershipError);
        assert.equal(error.ownerPid, process.pid);
        assert.equal(error.dbPath, fs.realpathSync(root) + path.sep + 'agentmonitor.db');
        return true;
      },
    );
  } finally {
    owner.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one process can own different databases concurrently', () => {
  const root = tempRoot();
  const first = acquireRuntimeOwnership(path.join(root, 'first.db'));
  const second = acquireRuntimeOwnership(path.join(root, 'second.db'));

  try {
    assert.notEqual(first.lockPath, second.lockPath);
  } finally {
    second.release();
    first.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ownership left by a dead process is recovered automatically', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'stale.db');
  const moduleUrl = pathToFileURL(path.resolve('src/runtime-ownership.ts')).href;
  const child = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    `import { acquireRuntimeOwnership } from ${JSON.stringify(moduleUrl)}; acquireRuntimeOwnership(${JSON.stringify(dbPath)});`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);

  const recovered = acquireRuntimeOwnership(dbPath);
  try {
    assert.equal(fs.existsSync(recovered.lockPath), true);
  } finally {
    recovered.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('simultaneous contenders produce exactly one database owner', async () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'contended.db');
  const moduleUrl = pathToFileURL(path.resolve('src/runtime-ownership.ts')).href;
  const script = `
    import { acquireRuntimeOwnership, RuntimeOwnershipError } from ${JSON.stringify(moduleUrl)};
    try {
      acquireRuntimeOwnership(${JSON.stringify(dbPath)});
      setTimeout(() => process.exit(0), 2000);
    } catch (error) {
      process.exit(error instanceof RuntimeOwnershipError ? 2 : 3);
    }
  `;
  const contenders = Array.from({ length: 6 }, () => spawn(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
  }));

  const statuses = await Promise.all(contenders.map(child => new Promise<number | null>((resolve) => {
    child.once('close', code => resolve(code));
  })));

  try {
    assert.equal(statuses.filter(code => code === 0).length, 1);
    assert.equal(statuses.filter(code => code === 2).length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed ownership state is treated as stale', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'malformed.db');
  const initial = acquireRuntimeOwnership(dbPath);
  const lockPath = initial.lockPath;
  initial.release();
  fs.writeFileSync(lockPath, 'not-json');

  const recovered = acquireRuntimeOwnership(dbPath);
  try {
    assert.equal(recovered.lockPath, lockPath);
  } finally {
    recovered.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ownership state for another database is treated as stale', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'mismatched.db');
  const initial = acquireRuntimeOwnership(dbPath);
  const lockPath = initial.lockPath;
  initial.release();
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: 'not-this-database',
    dbPath: path.join(root, 'different.db'),
  })}\n`);

  const recovered = acquireRuntimeOwnership(dbPath);
  try {
    assert.equal(recovered.lockPath, lockPath);
  } finally {
    recovered.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release cannot remove ownership that was replaced by another token', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'token.db');
  const first = acquireRuntimeOwnership(dbPath);
  const displacedPath = `${first.lockPath}.displaced`;
  fs.renameSync(first.lockPath, displacedPath);
  const replacement = acquireRuntimeOwnership(dbPath);

  try {
    first.release();
    assert.throws(() => acquireRuntimeOwnership(dbPath), RuntimeOwnershipError);
  } finally {
    replacement.release();
    fs.rmSync(displacedPath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real and symlinked paths to one existing database share ownership', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'real.db');
  const aliasPath = path.join(root, 'alias.db');
  fs.writeFileSync(dbPath, '');
  fs.symlinkSync(dbPath, aliasPath);
  const owner = acquireRuntimeOwnership(dbPath);

  try {
    assert.throws(() => acquireRuntimeOwnership(aliasPath), RuntimeOwnershipError);
  } finally {
    owner.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the live owner of a database is readable, with the build it loaded', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'owned.db');
  assert.equal(readRuntimeOwner(dbPath), null, 'nobody owns it yet');
  const owner = acquireRuntimeOwnership(dbPath, { build: 'abc123' });
  try {
    const read = readRuntimeOwner(dbPath);
    assert.deepEqual([read?.pid, read?.build], [process.pid, 'abc123']);
  } finally {
    owner.release();
  }
  assert.equal(readRuntimeOwner(dbPath), null, 'released ownership is gone');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a dead owner is not reported, and reading creates nothing', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'dead.db');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(`${dbPath}.runtime.lock`, JSON.stringify({
    pid: dead.pid, startedAt: new Date().toISOString(), token: 't', dbPath: fs.realpathSync(root) + '/dead.db', build: 'old',
  }));
  assert.equal(readRuntimeOwner(dbPath), null);
  // A lock carried over from another database (copied with the file) is not this database's owner.
  fs.writeFileSync(`${dbPath}.runtime.lock`, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), token: 't', dbPath: '/elsewhere/other.db', build: 'old',
  }));
  assert.equal(readRuntimeOwner(dbPath), null);
  const missing = path.join(root, 'no-such-dir', 'x.db');
  assert.equal(readRuntimeOwner(missing), null);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a command warns only when the server on its database runs another build', () => {
  const warning = staleServerWarning({ pid: 4242, build: 'old' }, 'new');
  assert.match(warning ?? '', /4242/);
  assert.match(warning ?? '', /restart/i);
  assert.equal(staleServerWarning({ pid: 4242, build: 'same' }, 'same'), null);
  assert.equal(staleServerWarning(null, 'new'), null, 'no server');
  assert.equal(staleServerWarning({ pid: 4242, build: null }, 'new'), null, 'a server run from source');
  assert.equal(staleServerWarning({ pid: 4242, build: 'old' }, null), null, 'a command run from source');
});
