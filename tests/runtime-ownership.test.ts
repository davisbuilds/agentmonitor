import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  acquireRuntimeOwnership,
  RuntimeOwnershipError,
} from '../src/runtime-ownership.js';

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
