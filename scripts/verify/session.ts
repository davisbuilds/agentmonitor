import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const fixtureVersion = 'verification-v1';
export const sessionPrefix = 'agentmonitor-verify-';

export function writeJson(file: string, value: unknown) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function treeDigest(root: string): string {
  const hash = createHash('sha256');
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
      else throw new Error(`Unexpected non-regular build entry: ${file}`);
    }
  }
  visit(root);
  return hash.digest('hex');
}

export function provenance() {
  for (const file of ['dist/app.js', 'frontend/dist/index.html']) {
    if (!fs.existsSync(path.join(repoRoot, file))) throw new Error(`${file} missing; run pnpm build`);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  return {
    revision: git('rev-parse', 'HEAD'),
    worktree_status: git('status', '--porcelain'),
    backend_sha256: treeDigest(path.join(repoRoot, 'dist')),
    frontend_sha256: treeDigest(path.join(repoRoot, 'frontend/dist')),
    verifier_sha256: treeDigest(path.join(repoRoot, 'scripts/verify')),
    benchmark_sha256: createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'scripts/benchmark-usage-overview.ts'))).digest('hex'),
    lockfile_sha256: createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'))).digest('hex'),
    fixture: fixtureVersion,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    host: os.hostname(),
    captured_at: new Date().toISOString(),
  };
}

export interface Session {
  schema_version: 1;
  id: string;
  directory: string;
  status: 'running' | 'stopped' | 'failed';
  url: string;
  control_url: string;
  expires_at: string;
  provenance: ReturnType<typeof provenance>;
  error?: string;
}

export function readSession(directory: string): Session {
  const resolved = fs.realpathSync(directory);
  if (!path.basename(resolved).startsWith(sessionPrefix)
    || path.dirname(resolved) !== fs.realpathSync(os.tmpdir())) {
    throw new Error('Expected a verification session directory returned by start');
  }
  const session = JSON.parse(fs.readFileSync(path.join(resolved, 'session.json'), 'utf8')) as Session;
  if (session.schema_version !== 1 || fs.realpathSync(session.directory) !== resolved) throw new Error('Invalid verification session');
  for (const address of [session.url, session.control_url]) {
    const url = new URL(address);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/') {
      throw new Error('Invalid verification endpoint');
    }
  }
  return session;
}

export async function control(session: Session, action: 'status' | 'advance' | 'stop') {
  const token = fs.readFileSync(path.join(session.directory, 'control-token'), 'utf8');
  const response = await fetch(`${session.control_url}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Verification host ${action}: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

export async function stopSession(session: Session): Promise<Session> {
  const current = readSession(session.directory);
  if (current.status === 'stopped') return current;
  await control(current, 'stop');
  const stopped = readSession(current.directory);
  if (stopped.status !== 'stopped') throw new Error('Host did not confirm cleanup');
  return stopped;
}

export class StartupError extends Error {
  constructor(message: string, readonly directory: string, readonly identity: ReturnType<typeof provenance>, cause: unknown) {
    super(message, { cause });
  }
}

export async function startSession(signal?: AbortSignal): Promise<Session> {
  signal?.throwIfAborted();
  const identity = provenance();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), sessionPrefix));
  fs.chmodSync(directory, 0o700);
  writeJson(path.join(directory, 'startup.json'), { id: randomUUID(), provenance: identity });
  fs.writeFileSync(path.join(directory, 'control-token'), randomUUID(), { mode: 0o600 });
  const log = fs.openSync(path.join(directory, 'host.log'), 'a', 0o600);
  // Only the environment needed to launch Node is inherited; provider credentials,
  // runtime database overrides, and ambient application configuration stay outside.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'SystemRoot']) if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'scripts/verify/host.ts'), directory], {
    cwd: repoRoot, env, detached: true, stdio: ['ignore', log, log, 'ipc'],
  });
  fs.closeSync(log);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Verification startup timed out')), 25_000);
      const aborted = () => finish(new Error('Verification startup interrupted'));
      const exited = (code: number | null) => finish(new Error(`Verification host exited (${code}); see ${directory}/host.log`));
      const message = (payload: unknown) => {
        if (payload === 'ready') finish();
      };
      function finish(error?: Error) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        child.off('exit', exited);
        child.off('error', finish);
        child.off('message', message);
        if (error) reject(error); else resolve();
      }
      child.once('exit', exited);
      child.once('error', finish);
      child.on('message', message);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
    if (child.connected) child.disconnect();
    child.unref();
    return readSession(directory);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    writeJson(path.join(directory, 'failure.json'), { schema_version: 1, status: 'blocked', error: String(error), cleanup: 'host_exited', provenance: identity });
    throw new StartupError(`${error instanceof Error ? error.message : String(error)}; artifacts: ${directory}`, directory, identity, error);
  }
}
