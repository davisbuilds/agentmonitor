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

/** Runs the runner on test files given as name → source, inside a temp directory this test owns. */
function runGuarded(testSource: string | Record<string, string>, extraEnv: Record<string, string> = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-guard-'));
  workDirs.push(work);
  const sharedTmp = path.join(work, 'shared-tmp');
  fs.mkdirSync(sharedTmp);
  const sources = typeof testSource === 'string' ? { 'fixture.test.mjs': testSource } : testSource;
  const testFiles = Object.entries(sources).map(([name, source]) => {
    const file = path.join(work, name);
    fs.writeFileSync(file, source);
    return file;
  });
  // NODE_TEST_CONTEXT would make the nested `node --test` report to this run instead of exiting on its own result.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = spawnSync(process.execPath, [RUNNER, ...testFiles], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...env, TMPDIR: sharedTmp, TMP: sharedTmp, TEMP: sharedTmp, ...extraEnv },
  });
  return {
    status: result.status,
    stdout: result.stdout,
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

const SHARD_FIXTURES = {
  'a.test.mjs': `${HEADER}test('fixture-alpha', () => {});\n`,
  'b.test.mjs': `${HEADER}test('fixture-bravo', () => {});\n`,
  'env.test.mjs': `${HEADER}test('fixture-env', () => { if (process.env.AGENTMONITOR_TEST_SHARD) throw new Error('shard variable reached the tests'); });\n`,
};
const ran = (stdout: string) => ['fixture-alpha', 'fixture-bravo', 'fixture-env'].filter(name => stdout.includes(name));

test('AGENTMONITOR_TEST_SHARD splits the files between shards, and every file runs in exactly one', () => {
  const first = runGuarded(SHARD_FIXTURES, { AGENTMONITOR_TEST_SHARD: '1/2' });
  const second = runGuarded(SHARD_FIXTURES, { AGENTMONITOR_TEST_SHARD: '2/2' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const [a, b] = [ran(first.stdout), ran(second.stdout)];
  assert.ok(a.length > 0 && b.length > 0, `each shard runs something: ${a} | ${b}`);
  assert.deepEqual([...a, ...b].sort(), ['fixture-alpha', 'fixture-bravo', 'fixture-env']);
});

test('the shard and concurrency variables are consumed, not passed on to the tests', () => {
  const run = runGuarded(SHARD_FIXTURES, { AGENTMONITOR_TEST_SHARD: '1/1', AGENTMONITOR_TEST_CONCURRENCY: '2' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(ran(run.stdout), ['fixture-alpha', 'fixture-bravo', 'fixture-env']);
});

for (const [name, value] of [['AGENTMONITOR_TEST_SHARD', '3/2'], ['AGENTMONITOR_TEST_SHARD', 'half'], ['AGENTMONITOR_TEST_CONCURRENCY', '0']]) {
  test(`an invalid ${name} (${value}) fails before any test runs`, () => {
    const run = runGuarded(SHARD_FIXTURES, { [name]: value });
    assert.equal(run.status, 2);
    assert.match(run.stderr, new RegExp(name));
    assert.deepEqual(ran(run.stdout), []);
    assert.deepEqual(run.sharedTmpEntries, [], 'no private temp directory is left behind');
  });
}
