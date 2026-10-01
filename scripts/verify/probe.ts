import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { provenance, repoRoot, writeJson } from './session.js';

export const snapshotPrefix = 'agentmonitor-snapshot-';

export const probes = [
  {
    id: 'health',
    target: 'installed',
    description: 'Running server build/staleness, the process listening on its port, and database file sizes',
    limits: ['Reads /api/health and file metadata only; does not open the database'],
    deadline_ms: 15_000,
  },
  {
    id: 'ingestion',
    target: 'installed',
    description: 'Import and watcher state against the transcripts discoverable now: unstamped, pending, unwatched, and missing browser projections',
    limits: ['Counts only; no transcript content or paths', 'Claude and Codex transcripts; Antigravity is not inspected'],
    deadline_ms: 60_000,
  },
  {
    id: 'monitor-stats',
    target: 'installed',
    description: 'Per-statement timing and query plan for the reads a Monitor stats request runs (optionally filtered by --agent/--since)',
    limits: [
      'Times the product statements on a separate read-only connection, not through the HTTP server',
      'Omits the idle-session update the endpoint performs before reading',
      'Row counts only; result values are not recorded',
    ],
    deadline_ms: 120_000,
  },
  {
    id: 'snapshot',
    target: 'installed',
    description: 'Disposable copy of the database (SQLite online backup) for probes that must write',
    limits: ['Needs free disk of at least twice the database size; the copy stays until you remove it'],
    deadline_ms: 900_000,
  },
  {
    id: 'resync',
    target: 'scratch',
    description: 'Watcher re-sync of a transcript copy: end-to-end time for a prefix and then an append, plus read/parse/write/live/trace phases',
    limits: [
      'Writes only to a fresh scratch database or a snapshot made by this CLI; never the installed database',
      'Runs the compiled watcher functions directly, not chokidar or its debounce',
    ],
    deadline_ms: 300_000,
  },
] as const;

export type ProbeId = typeof probes[number]['id'];

export function probeById(id: string) {
  const probe = probes.find(entry => entry.id === id);
  if (!probe) throw new Error(`Unknown probe: ${id}. Use list.`);
  return probe;
}

export interface ProbeOptions {
  db?: string;
  url?: string;
  agent?: string;
  since?: string;
  runs?: number;
  appendLines?: number;
  transcript?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DatabaseTarget {
  kind: 'installed' | 'snapshot' | 'explicit' | 'scratch';
  path: string;
  resolved_by: string;
}

/**
 * The installed database is the one the globally linked `amon` uses: its
 * package root's data/agentmonitor.db. Ambient AGENTMONITOR_DB_PATH is ignored,
 * as in the fixture host; pass --db to probe another file.
 */
export function installedDatabase(): DatabaseTarget {
  let binary: string;
  try {
    binary = execFileSync('/usr/bin/which', ['amon'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No installed amon on PATH; pass --db <path> to name a database');
  }
  // npm links a symlink to dist/cli.js; pnpm writes a shell shim that execs it.
  let cli = fs.realpathSync(binary);
  if (!cli.endsWith(`${path.sep}dist${path.sep}cli.js`)) {
    const target = fs.readFileSync(cli, 'utf8').match(/"\$basedir\/([^"]+\/dist\/cli\.js)"/)?.[1];
    if (!target) throw new Error(`Cannot tell which checkout ${binary} runs; pass --db <path>`);
    cli = fs.realpathSync(path.join(path.dirname(binary), target));
  }
  const root = path.dirname(path.dirname(cli));
  const file = path.join(root, 'data', 'agentmonitor.db');
  if (!fs.existsSync(file)) throw new Error(`Installed amon at ${root} has no data/agentmonitor.db`);
  return { kind: 'installed', path: fs.realpathSync(file), resolved_by: `which amon -> ${cli}` };
}

function isSnapshot(file: string): boolean {
  const resolved = fs.realpathSync(file);
  const dir = path.dirname(resolved);
  return path.basename(dir).startsWith(snapshotPrefix) && path.dirname(dir) === fs.realpathSync(os.tmpdir());
}

export function resolveTarget(probe: ReturnType<typeof probeById>, options: ProbeOptions, evidence: string): DatabaseTarget | null {
  if (probe.id === 'resync') {
    if (!options.db) return { kind: 'scratch', path: path.join(evidence, 'scratch.db'), resolved_by: 'fresh scratch database' };
    // A probe that writes may only touch a copy this CLI made.
    if (!fs.existsSync(options.db) || !isSnapshot(options.db)) {
      throw new Error('resync writes; --db must be a snapshot created by `verify probe snapshot`');
    }
    return { kind: 'snapshot', path: fs.realpathSync(options.db), resolved_by: '--db (snapshot)' };
  }
  if (options.db) {
    if (!fs.existsSync(options.db)) throw new Error(`--db ${options.db} does not exist`);
    return { kind: isSnapshot(options.db) ? 'snapshot' : 'explicit', path: fs.realpathSync(options.db), resolved_by: '--db' };
  }
  if (probe.id === 'health') {
    // Health is useful without a database: it still reports the server.
    try { return installedDatabase(); } catch { return null; }
  }
  return installedDatabase();
}

function fileSizes(file: string) {
  const size = (suffix: string) => {
    try { return fs.statSync(file + suffix).size; } catch { return null; }
  };
  return { db_bytes: size(''), wal_bytes: size('-wal'), shm_bytes: size('-shm') };
}

/**
 * Run one probe in a child process. SQLite statements cannot be interrupted
 * from JavaScript, so the deadline kills the child; that also releases any
 * read snapshot it held on the installed database's WAL.
 */
export async function runProbe(id: string, options: ProbeOptions = {}) {
  const probe = probeById(id);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-evidence-'));
  fs.chmodSync(directory, 0o700);
  const deadline = options.timeoutMs ?? probe.deadline_ms;
  const result = {
    schema_version: 1,
    kind: 'probe',
    probe: probe.id,
    status: 'blocked' as 'observed' | 'blocked',
    started_at: new Date().toISOString(),
    finished_at: '',
    directory,
    target: null as (DatabaseTarget & Record<string, unknown>) | null,
    runtime: null as ReturnType<typeof provenance> | null,
    request: { ...options, signal: undefined, timeoutMs: deadline },
    measurements: {} as Record<string, unknown>,
    observations: {} as Record<string, unknown>,
    limits: [...probe.limits] as string[],
    errors: [] as string[],
  };
  const persist = () => writeJson(path.join(directory, 'result.json'), result);
  persist();
  try {
    result.runtime = provenance();
    const target = resolveTarget(probe, options, directory);
    if (target) result.target = { ...target, ...(target.kind === 'scratch' ? {} : fileSizes(target.path)) };
    persist();
    const request = path.join(directory, 'request.json');
    writeJson(request, { probe: probe.id, target, options: result.request, evidence: directory });
    // Only what the worker needs: discovery reads HOME, and resync points the
    // compiled app at its scratch database before any module reads config.
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'TMPDIR', 'HOME', 'CODEX_HOME']) if (process.env[name]) env[name] = process.env[name];
    if (probe.id === 'resync' && target) env.AGENTMONITOR_DB_PATH = target.path;
    const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'scripts/verify/probe-worker.ts'), request], {
      cwd: repoRoot, env, stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
    const abort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', abort, { once: true });
    const [code, signal] = await exited;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    const output = path.join(directory, 'worker.json');
    if (signal === 'SIGKILL') throw new Error(options.signal?.aborted ? 'Probe interrupted' : `Probe exceeded its ${deadline} ms deadline and was killed`);
    if (code !== 0 || !fs.existsSync(output)) throw new Error(`Probe worker exited (${code}); see ${directory}/worker.log`);
    const worker = JSON.parse(fs.readFileSync(output, 'utf8')) as { measurements: Record<string, unknown>; observations: Record<string, unknown>; limits?: string[] };
    result.measurements = worker.measurements;
    result.observations = worker.observations;
    result.limits.push(...(worker.limits ?? []));
    if (result.target && result.target.kind !== 'scratch') Object.assign(result.target, { after: fileSizes(result.target.path) });
    result.status = 'observed';
  } catch (error) {
    result.errors.push(String(error));
  } finally {
    result.finished_at = new Date().toISOString();
    persist();
  }
  return result;
}
