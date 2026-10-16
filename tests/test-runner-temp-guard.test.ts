import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'test', 'run-node-tests.mjs');

const workDirs: string[] = [];
after(() => {
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the runner on one test file, inside a temp directory this test owns. */
function runGuarded(testSource: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-guard-'));
  workDirs.push(work);
  const sharedTmp = path.join(work, 'shared-tmp');
  fs.mkdirSync(sharedTmp);
  const testFile = path.join(work, 'fixture.test.mjs');
  fs.writeFileSync(testFile, testSource);
  // NODE_TEST_CONTEXT would make the nested `node --test` report to this run instead of exiting on its own result.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = spawnSync(process.execPath, [RUNNER, testFile], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...env, TMPDIR: sharedTmp, TMP: sharedTmp, TEMP: sharedTmp },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    sharedTmp,
    sharedTmpEntries: fs.readdirSync(sharedTmp).filter(entry => !TOOL_CACHES.includes(entry)),
  };
}

const TOOL_CACHES = [`tsx-${os.userInfo().uid}`, 'node-compile-cache'];

const HEADER = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';\n`;

test('a test that leaves a directory in the temp folder fails the run and names it', () => {
  const run = runGuarded(`${HEADER}test('leaks', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'leaky-fixture-')); });\n`);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Tests left 1 entry in the temp directory/);
  assert.match(run.stderr, /leaky-fixture-\w{6}/);
  assert.deepEqual(run.sharedTmpEntries, [], 'the leak and the private directory are both removed');
});

test('a run that cleans up passes, and writes to a toolchain cache reach the shared cache', () => {
  const run = runGuarded(`${HEADER}test('clean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-fixture-'));
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(path.join(os.tmpdir(), 'node-compile-cache', 'entry'), 'cached');
  });\n`);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /Tests left/);
  assert.deepEqual(run.sharedTmpEntries, []);
  assert.equal(fs.readFileSync(path.join(run.sharedTmp, 'node-compile-cache', 'entry'), 'utf8'), 'cached');
});

test('a failing test keeps its own exit code', () => {
  const run = runGuarded(`${HEADER}test('fails', () => { throw new Error('boom'); });\n`);
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stderr, /Tests left/);
  assert.deepEqual(run.sharedTmpEntries, []);
});
