import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_CLI = path.join(ROOT, 'dist', 'cli.js');

function requireBuiltCli(t: TestContext): boolean {
  if (fs.existsSync(DIST_CLI)) return true;
  t.skip('run pnpm build before exercising built CLI packaging checks');
  return false;
}

function runBuiltCli(args: string[]): string {
  const result = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

test('built CLI prints root help from the dist artifact', (t) => {
  if (!requireBuiltCli(t)) return;

  const stdout = runBuiltCli(['--help']);

  assert.match(stdout, /Usage: amon \[global flags\] <command> \[args\]/);
  assert.match(stdout, /Both 'amon' and 'agentmonitor' run this CLI/);
});

test('built CLI keeps a shebang and executable mode', (t) => {
  if (!requireBuiltCli(t)) return;

  const source = fs.readFileSync(DIST_CLI, 'utf8');
  const stat = fs.statSync(DIST_CLI);

  assert.ok(source.startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') {
    assert.ok(isExecutable(stat.mode), `expected ${DIST_CLI} to be executable`);
  }
});

test('package dry-run includes executable CLI aliases', (t) => {
  if (!requireBuiltCli(t)) return;

  assert.equal(pkg.bin?.amon, './dist/cli.js');
  assert.equal(pkg.bin?.agentmonitor, './dist/cli.js');

  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const packs = JSON.parse(result.stdout) as Array<{
    files: Array<{ path: string; mode: number }>;
  }>;
  const cliEntry = packs[0]?.files.find(file => file.path === 'dist/cli.js');

  assert.ok(cliEntry, 'expected npm pack dry-run to include dist/cli.js');
  if (process.platform !== 'win32') {
    assert.ok(isExecutable(cliEntry.mode), 'expected packed dist/cli.js to be executable');
  }
});
