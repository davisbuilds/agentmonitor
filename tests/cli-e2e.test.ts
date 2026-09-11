import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
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

function runBuiltCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
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

test('built CLI runs when invoked through package bin symlinks', (t) => {
  if (!requireBuiltCli(t)) return;
  if (process.platform === 'win32') {
    t.skip('npm bin shims are not symlinks on Windows');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.tmp-cli-bin-'));
  try {
    for (const name of ['amon', 'agentmonitor']) {
      const binPath = path.join(tempDir, name);
      fs.symlinkSync(DIST_CLI, binPath);

      const version = spawnSync(binPath, ['--version'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      assert.equal(version.status, 0, version.stderr || version.stdout);
      assert.equal(version.stdout.trim(), pkg.version);

      const help = spawnSync(binPath, ['--help'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      assert.equal(help.status, 0, help.stderr || help.stdout);
      assert.match(help.stdout, new RegExp(`Usage: ${name} \\[global flags\\] <command> \\[args\\]`));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('built reporting CLI supports eight concurrent reads of one database', async (t) => {
  if (!requireBuiltCli(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-concurrent-'));
  const dbPath = path.join(tempDir, 'agentmonitor.db');
  try {
    runBuiltCli(['--db-path', dbPath, 'analytics', 'summary', '--json']);

    const results = await Promise.all(Array.from({ length: 8 }, () => (
      runBuiltCliAsync(['--db-path', dbPath, 'analytics', 'summary', '--json'])
    )));

    for (const [index, result] of results.entries()) {
      assert.equal(result.status, 0, `child ${index + 1}: ${result.stderr || result.stdout}`);
      assert.equal(result.stderr, '', `child ${index + 1} wrote diagnostics`);
      const payload = JSON.parse(result.stdout) as { total_sessions?: number; coverage?: unknown };
      assert.equal(typeof payload.total_sessions, 'number', `child ${index + 1} returned the wrong JSON contract`);
      assert.ok(payload.coverage, `child ${index + 1} omitted coverage`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('built local read command families remain readable while the server holds a write transaction', async (t) => {
  if (!requireBuiltCli(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-writer-'));
  const dbPath = path.join(tempDir, 'agentmonitor.db');
  let writer: Database.Database | undefined;
  try {
    runBuiltCli(['--db-path', dbPath, 'analytics', 'summary', '--json']);
    writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.exec('BEGIN IMMEDIATE');

    const reads = [
      runBuiltCliAsync(['--db-path', dbPath, 'analytics', 'summary', '--json']),
      runBuiltCliAsync(['--db-path', dbPath, 'sessions', 'list', '--json']),
      runBuiltCliAsync(['--db-path', dbPath, 'ops', 'metrics', '--json']),
    ];
    const allReads = Promise.all(reads);
    const completedWhileLocked = await Promise.race([
      allReads.then(results => ({ completed: true as const, results })),
      new Promise<{ completed: false }>(resolve => setTimeout(() => resolve({ completed: false }), 2_000)),
    ]);

    writer.exec('ROLLBACK');
    writer.close();
    writer = undefined;

    const results = completedWhileLocked.completed ? completedWhileLocked.results : await allReads;
    assert.equal(completedWhileLocked.completed, true, 'read commands waited on a writer instead of using the WAL read path');
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
  } finally {
    if (writer?.inTransaction) writer.exec('ROLLBACK');
    writer?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('concurrent built local reads initialize an older database before querying', async (t) => {
  if (!requireBuiltCli(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-upgrade-'));
  const dbPath = path.join(tempDir, 'agentmonitor.db');
  try {
    runBuiltCli(['--db-path', dbPath, 'analytics', 'summary', '--json']);
    const db = new Database(dbPath);
    db.pragma('user_version = 6');
    db.close();

    const results = await Promise.all(Array.from({ length: 4 }, () => (
      runBuiltCliAsync(['--db-path', dbPath, 'analytics', 'summary', '--json'])
    )));
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(typeof (JSON.parse(result.stdout) as { total_sessions?: number }).total_sessions, 'number');
    }

    const upgraded = new Database(dbPath, { readonly: true });
    assert.equal(upgraded.pragma('user_version', { simple: true }), 7);
    upgraded.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('built usage budgets initializes a fresh database when budget evaluation needs usage', async (t) => {
  if (!requireBuiltCli(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-budgets-'));
  const dbPath = path.join(tempDir, 'agentmonitor.db');
  const budgetsPath = path.join(tempDir, 'budgets.json');
  try {
    fs.writeFileSync(budgetsPath, JSON.stringify({
      budgets: [{ name: 'Agent budget', period: 'all_time', limit_usd: 10 }],
    }));
    const result = await runBuiltCliAsync(
      ['--db-path', dbPath, 'usage', 'budgets', '--json'],
      { ...process.env, AGENTMONITOR_USAGE_BUDGETS_PATH: budgetsPath },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout) as { data?: Array<{ name?: string }> };
    assert.equal(payload.data?.[0]?.name, 'Agent budget');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
