import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { provenance, repoRoot, writeJson } from './session.js';

export const snapshotPrefix = 'agentmonitor-snapshot-';
/** The reclaim probe's working copy, inside its evidence directory. */
export const RECLAIM_COPY = 'reclaim-copy.db';
/** The database file inside a snapshot directory. */
export const SNAPSHOT_FILE = 'agentmonitor.db';

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
    limits: ['Counts and resolved discovery scope only; no transcript content or individual file paths', 'Claude and Codex transcripts; Antigravity is not inspected'],
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
  {
    id: 'plans',
    target: 'snapshot',
    description: 'Index impact: run the compiled app on a snapshot, record the statements its read routes run, and compare their plans and timings with and without one index (--index NAME or a candidate --index-sql)',
    limits: [
      'Writes only to a snapshot made by this CLI: the app runs its startup migrations there, and --index-sql creates the candidate index',
      '--index-sql accepts one CREATE [UNIQUE] INDEX statement creating a new index; use --index for an existing index',
      'Covers the built-in route list; statements reached only by other routes or by writes are not compared',
      'Reports SQL text (truncated) and plans, not results; sql-corpus/routes.jsonl in the evidence directory keeps each statement with its parameters (identifiers such as session ids) for index-audit',
    ],
    deadline_ms: 900_000,
  },
  {
    id: 'hotspots',
    target: 'snapshot',
    description: 'Where reads spend their time: run the compiled app on a snapshot, then time and explain every statement its read routes ran, slowest first, with plan hints (an aggregate that looks up each match, a temporary sort, a full scan)',
    limits: [
      'Writes only to a snapshot made by this CLI: the app runs its startup migrations there',
      'Covers the built-in route list; statements reached only by other routes or by writes are not timed',
      'Reports SQL text (truncated) and plans, not results; sql-corpus/routes.jsonl in the evidence directory keeps each statement with its parameters (identifiers such as session ids) for index-audit',
    ],
    deadline_ms: 900_000,
  },
  {
    id: 'reclaim',
    target: 'installed',
    description: 'What `amon database compact` would reclaim: copy the database with the online backup API, run compact\'s search-index optimize and VACUUM on the copy, and report current against projected sizes',
    limits: [
      'Reads the database only, through the online backup API; the copy is deleted when the probe ends, even if it fails',
      'Needs free temporary space of about twice the database size, like a snapshot',
      'Projects the file size, not how long compact takes on the installed database',
    ],
    deadline_ms: 900_000,
  },
  {
    id: 'index-audit',
    target: 'installed',
    description: 'Which indexes on a table (--table, default events) the app\'s statements still need: record every statement the unit test suite runs, writers included (or reuse --corpus DIR), compare their plans with each index dropped on an empty copy of the schema, and propose a drop set that leaves no plan worse',
    limits: [
      'Reads the schema and index sizes through a read-only connection; plans are compared on an empty copy of the schema in the evidence directory, checked against the real database\'s plans',
      'Covers the statements the unit test suite runs, including the statements its plan tests explain; a variant no test reaches is not compared. Add the reads plans or hotspots recorded on a snapshot with --corpus <evidence>/sql-corpus',
      'Compares plans, not timings: confirm a drop with plans or hotspots on a snapshot',
      'Never proposes dropping a UNIQUE index',
    ],
    deadline_ms: 900_000,
  },
] as const;

export type ProbeId = typeof probes[number]['id'];

/** Probes that run the compiled app, and so its startup migrations, on a snapshot. */
const drivesApp = (id: ProbeId) => id === 'plans' || id === 'hotspots';

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
  index?: string;
  indexSql?: string;
  corpus?: string[];
  table?: string;
  timeoutMs?: number;
  retainTranscripts?: boolean;
  claudeDir?: string;
  codexHome?: string;
  excludePatterns?: string[];
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
  if (probe.id === 'resync' || drivesApp(probe.id)) {
    if (!options.db && probe.id === 'resync') return { kind: 'scratch', path: path.join(evidence, 'scratch.db'), resolved_by: 'fresh scratch database' };
    // A probe that writes may only touch a copy this CLI made.
    if (!options.db || !fs.existsSync(options.db) || !isSnapshot(options.db)) {
      throw new Error(`${probe.id} writes; --db must be a snapshot created by \`verify probe snapshot\``);
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
  // Resolve caller-relative roots before crossing into the worker's repo cwd.
  const absolute = (value: string) => path.resolve(value === '~' ? os.homedir()
    : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
  if (probe.id === 'index-audit' && options.corpus) options = { ...options, corpus: options.corpus.map(absolute) };
  if (probe.id === 'ingestion') options = {
    ...options,
    claudeDir: absolute(options.claudeDir ?? (process.env.AGENTMONITOR_CLAUDE_DIR?.trim() || path.join(os.homedir(), '.claude'))),
    codexHome: absolute(options.codexHome ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))),
  };
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
    content_artifacts: [] as string[],
    cleanup: probe.id === 'resync' || probe.id === 'reclaim' || probe.id === 'snapshot' ? 'pending' : 'not_applicable',
  };
  const persist = () => writeJson(path.join(directory, 'result.json'), result);
  persist();
  // The parent creates the snapshot directory so it can remove a partial copy
  // when the worker fails or is killed mid-backup.
  let snapshotDir: string | null = null;
  try {
    options.signal?.throwIfAborted();
    result.runtime = provenance();
    const target = resolveTarget(probe, options, directory);
    if (target) result.target = { ...target, ...(target.kind === 'scratch' ? {} : fileSizes(target.path)) };
    persist();
    if (probe.id === 'snapshot') {
      snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
      fs.chmodSync(snapshotDir, 0o700);
    }
    const request = path.join(directory, 'request.json');
    writeJson(request, { probe: probe.id, target, options: result.request, evidence: directory, snapshot_dir: snapshotDir });
    // Only what the worker needs: discovery reads HOME, and resync points the
    // compiled app at its scratch database before any module reads config.
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'TMPDIR', 'HOME', 'CODEX_HOME']) if (process.env[name]) env[name] = process.env[name];
    if (probe.id === 'ingestion' && process.env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS !== undefined) {
      env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS = process.env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS;
    }
    if ((probe.id === 'resync' || drivesApp(probe.id)) && target) env.AGENTMONITOR_DB_PATH = target.path;
    if (drivesApp(probe.id)) {
      // The app reads these at startup; keep it off real catalogs and auto-import.
      const empty = path.join(directory, 'empty');
      fs.mkdirSync(empty);
      Object.assign(env, { AGENTMONITOR_AUTO_IMPORT_MINUTES: '0', AGENTMONITOR_SKILL_CATALOG_DIRS: empty });
    }
    const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    // Its own process group, so the deadline also kills anything the worker
    // started, such as the test suite index-audit records.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'scripts/verify/probe-worker.ts'), request], {
      cwd: repoRoot, env, stdio: ['ignore', log, log], detached: true,
    });
    fs.closeSync(log);
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(kill, deadline);
    const abort = kill;
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let code: number | null;
    let signal: NodeJS.Signals | null;
    try { [code, signal] = await exited; }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
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
    if (probe.id === 'resync') {
      // The parent owns cleanup: the worker may have failed or been SIGKILLed.
      // Only remove paths created inside this run's fresh evidence directory.
      try {
        const transcripts = path.join(directory, 'transcripts');
        if (options.retainTranscripts) {
          if (fs.existsSync(transcripts)) result.content_artifacts.push(transcripts);
        } else fs.rmSync(transcripts, { recursive: true, force: true });
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(directory, 'scratch.db' + suffix), { force: true });
        result.cleanup = 'complete';
      } catch (error) {
        result.cleanup = 'failed';
        result.status = 'blocked';
        result.errors.push(`Content cleanup failed in ${directory}: ${String(error)}`);
      }
      if (result.target?.kind === 'snapshot') result.content_artifacts.push(result.target.path);
    }
    if (snapshotDir && result.status === 'observed') {
      result.content_artifacts.push(path.join(snapshotDir, SNAPSHOT_FILE));
      result.cleanup = 'retained';
    } else if (snapshotDir) {
      try {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
        result.cleanup = 'complete';
      } catch (error) {
        result.cleanup = 'failed';
        result.errors.push(`Snapshot cleanup failed in ${snapshotDir}: ${String(error)}`);
      }
    } else if (probe.id === 'snapshot') result.cleanup = 'complete';
    if (probe.id === 'reclaim') {
      // The copy holds the whole database; the parent removes it because the
      // worker may have failed or been killed before it could.
      try {
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(directory, `${RECLAIM_COPY}${suffix}`), { force: true });
        result.cleanup = 'complete';
      } catch (error) {
        result.cleanup = 'failed';
        result.status = 'blocked';
        result.errors.push(`Content cleanup failed in ${directory}: ${String(error)}`);
      }
    }
    if (drivesApp(probe.id) && result.target?.kind === 'snapshot') result.content_artifacts.push(result.target.path);
    result.finished_at = new Date().toISOString();
    persist();
  }
  return result;
}
