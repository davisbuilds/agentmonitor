import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = performance.now() + 10_000;
  let lastError: unknown;

  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`serve exited early with ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${baseUrl}/api/health: ${String(lastError)}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('close', () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  ]);
}

function writeFakePortless(dir: string): string {
  const scriptPath = path.join(dir, 'fake-portless.mjs');
  fs.writeFileSync(scriptPath, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const markerPath = process.env.AGENTMONITOR_PORTLESS_MARKER;
if (!markerPath) throw new Error('Missing AGENTMONITOR_PORTLESS_MARKER');
fs.writeFileSync(markerPath, JSON.stringify(args));

const commandIndex = args.indexOf(process.execPath);
if (commandIndex === -1) throw new Error('Missing child Node command');
const appPortIndex = args.indexOf('--app-port');
const appPort = appPortIndex === -1 ? '' : args[appPortIndex + 1];
const child = spawn(args[commandIndex], args.slice(commandIndex + 1), {
  env: {
    ...process.env,
    PORT: appPort,
    PORTLESS_URL: 'https://agentmonitor.localhost',
  },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`);
  return scriptPath;
}

test('serve starts a runtime that health and status can inspect', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-runtime-'));
  const dbPath = path.join(tempDir, 'runtime.db');
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AGENTMONITOR_DB_PATH: dbPath,
    AGENTMONITOR_AUTO_IMPORT_MINUTES: '0',
    AGENTMONITOR_PORTLESS_CLI: path.join(tempDir, 'missing-portless-cli.js'),
    PATH: '/usr/bin:/bin',
  };
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    'src/cli.ts',
    'serve',
    '--no-portless',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--no-import',
    '--no-watch',
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    await waitForHealth(baseUrl, child);

    const health = runCli(['--url', baseUrl, 'health', '--json'], env);
    assert.equal(health.status, 0, health.stderr);
    const healthJson = JSON.parse(health.stdout) as { status?: string };
    assert.equal(healthJson.status, 'ok');

    const status = runCli(['--db-path', dbPath, '--url', baseUrl, 'status', '--json'], env);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as {
      url?: string;
      db_path?: string;
      db_exists?: boolean;
      server_reachable?: boolean;
    };
    assert.equal(statusJson.url, baseUrl);
    assert.equal(statusJson.db_path, dbPath);
    assert.equal(statusJson.db_exists, true);
    assert.equal(statusJson.server_reachable, true);
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.match(stdout, new RegExp(`AgentMonitor listening on http://127\\.0\\.0\\.1:${port}`));
  assert.equal(stderr, '');
});

test('serve launches the runtime through Portless by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-portless-runtime-'));
  const dbPath = path.join(tempDir, 'runtime.db');
  const markerPath = path.join(tempDir, 'portless-args.json');
  const portlessCli = writeFakePortless(tempDir);
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AGENTMONITOR_DB_PATH: dbPath,
    AGENTMONITOR_AUTO_IMPORT_MINUTES: '0',
    AGENTMONITOR_PORTLESS_CLI: portlessCli,
    AGENTMONITOR_PORTLESS_MARKER: markerPath,
  };
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    'src/cli.ts',
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--no-import',
    '--no-watch',
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'pipe',
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });

  try {
    await waitForHealth(baseUrl, child);
    assert.equal(fs.existsSync(markerPath), true, 'Portless wrapper was not invoked');
    const portlessArgs = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as string[];
    assert.deepEqual(portlessArgs.slice(0, 4), [
      '--name',
      'agentmonitor',
      '--app-port',
      String(port),
    ]);
    assert.equal(portlessArgs.includes('--no-portless'), true);
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.match(stdout, /Dashboard: https:\/\/agentmonitor\.localhost\/app\//);
  assert.equal(child.exitCode, 0, 'Portless-backed serve should shut down cleanly');
});

test('health exits 3 when the server is unavailable', () => {
  const result = runCli(['--url', 'http://127.0.0.1:1', 'health']);

  assert.equal(result.status, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Cannot reach http:\/\/127\.0\.0\.1:1\/api\/health/);
});

test('status reports unavailable servers without failing the command', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-status-'));
  const dbPath = path.join(tempDir, 'status.db');

  try {
    const result = runCli(['--db-path', dbPath, '--url', 'http://127.0.0.1:1', 'status', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { db_exists?: boolean; server_reachable?: boolean };
    assert.equal(parsed.db_exists, false);
    assert.equal(parsed.server_reachable, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
