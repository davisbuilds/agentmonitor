import type * as V2Queries from '../../src/db/v2-queries.js';
import type * as WatcherIndex from '../../src/watcher/index.js';
import type * as ClaudeParser from '../../src/parser/claude-code.js';
import type * as CodexParser from '../../src/parser/codex-sessions.js';
import type * as ClaudeLive from '../../src/live/claude-adapter.js';
import type * as CodexLive from '../../src/live/codex-adapter.js';
import type * as TraceService from '../../src/trace-quality/service.js';
import type * as Connection from '../../src/db/connection.js';
import type * as Schema from '../../src/db/schema.js';
import type * as Config from '../../src/config.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openReadOnly } from './readonly.js';
import { repoRoot, writeJson } from './session.js';
import { snapshotPrefix, type DatabaseTarget, type ProbeId, type ProbeOptions } from './probe.js';

const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as {
  probe: ProbeId; target: DatabaseTarget | null; options: ProbeOptions; evidence: string;
};
const built = (module: string) => pathToFileURL(path.join(repoRoot, 'dist', module)).href;
const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function health(options: ProbeOptions) {
  const base = options.url ?? 'http://127.0.0.1:3141';
  const url = new URL(base);
  let server: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(3_000) });
    server = await response.json() as Record<string, unknown>;
  } catch (cause) { error = String(cause); }
  let listener: Record<string, unknown> | null = null;
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${url.port || '80'}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
    const pid = out.match(/^p(\d+)/m)?.[1];
    if (pid) {
      listener = {
        pid: Number(pid),
        command: out.match(/^c(.+)$/m)?.[1] ?? null,
        started: execFileSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8' }).trim(),
        args: execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).trim(),
      };
    }
  } catch { /* lsof finds nothing, or is unavailable */ }
  const dbBytes = request.target ? fs.statSync(request.target.path).size : null;
  const reported = typeof server?.db_size_bytes === 'number' ? server.db_size_bytes : null;
  return {
    measurements: {},
    observations: {
      url: base,
      server,
      server_error: error,
      listener,
      build: server?.build ?? null,
      // Size is the only database identity /api/health exposes.
      target_matches_running_server: reported === null || dbBytes === null ? 'unknown' : reported === dbBytes,
    },
  };
}

async function ingestion() {
  const db = openReadOnly(request.target!.path);
  const { createConfig } = await import(built('config.js')) as typeof Config;
  const { discoverSessionFiles, discoverCodexSessionFiles, findMissingSessionProjections } = await import(built('watcher/index.js')) as typeof WatcherIndex;
  const config = createConfig(process.env);
  const options = { excludePatterns: config.sync.excludePatterns };
  const files = {
    claude: discoverSessionFiles(config.claudeDir, options),
    codex: discoverCodexSessionFiles(undefined, options),
  };
  const importState = new Map((db.prepare('SELECT file_path, file_hash, file_size, file_mtime FROM import_state').all() as Array<{
    file_path: string; file_hash: string; file_size: number; file_mtime: string | null;
  }>).map(row => [row.file_path, row]));
  const watched = new Map((db.prepare('SELECT file_path, status FROM watched_files').all() as Array<{
    file_path: string; status: string;
  }>).map(row => [row.file_path, row]));
  const summary: Record<string, unknown> = {};
  for (const [source, list] of Object.entries(files)) {
    // Mirrors the auto-import skip and the watcher's change check without reading files.
    const imports: Record<string, number> = { unchanged: 0, changed_since_import: 0, unstamped: 0, invalidated: 0, never_imported: 0 };
    // The watcher keeps no mtime for files it skipped by hash, so only its
    // recorded status is reported here, not whether a file changed since.
    const watcher: Record<string, number> = { parsed: 0, skipped: 0, error: 0, unwatched: 0 };
    for (const file of list) {
      const stat = fs.statSync(file, { bigint: true });
      const state = importState.get(file);
      if (!state) imports.never_imported++;
      else if (state.file_hash === '') imports.invalidated++;
      else if (state.file_mtime === null) imports.unstamped++;
      else if (state.file_mtime !== stat.mtimeNs.toString() || state.file_size !== Number(stat.size)) imports.changed_since_import++;
      else imports.unchanged++;
      const seen = watched.get(file);
      if (!seen) watcher.unwatched++;
      else watcher[seen.status] = (watcher[seen.status] ?? 0) + 1;
    }
    summary[source] = {
      discovered: list.length,
      import_state: imports,
      watcher,
      missing_browser_projection: findMissingSessionProjections(db, list).length,
    };
  }
  const recency = db.prepare(`
    SELECT MAX(imported_at) AS last_import, (SELECT MAX(last_parsed_at) FROM watched_files) AS last_parse FROM import_state
  `).get();
  db.close();
  return { measurements: {}, observations: { ...summary, ...(recency as object) } };
}

async function monitorStats(options: ProbeOptions) {
  const db = openReadOnly(request.target!.path);
  const { monitorStatsStatements } = await import(built('db/v2-queries.js')) as typeof V2Queries;
  const runs = Math.max(1, options.runs ?? 1);
  const statements = monitorStatsStatements({ agent: options.agent, since: options.since }).statements.map(statement => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.values) as Array<{ detail: string }>)
      .map(row => row.detail);
    const samples: number[] = [];
    let rows = 0;
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      rows = db.prepare(statement.sql).all(...statement.values).length;
      samples.push(elapsed(start));
    }
    return { name: statement.name, median_ms: median(samples), samples_ms: samples, rows, plan };
  });
  db.close();
  return {
    measurements: {
      total_median_ms: Math.round(statements.reduce((sum, entry) => sum + entry.median_ms, 0) * 100) / 100,
      statements,
    },
    observations: { filter: { agent: options.agent ?? null, since: options.since ?? null }, runs },
    limits: [runs === 1 ? 'One sample per statement, no warmup' : `${runs} samples per statement, no separate warmup`],
  };
}

async function snapshot() {
  const source = request.target!.path;
  const bytes = fs.statSync(source).size + (fs.existsSync(`${source}-wal`) ? fs.statSync(`${source}-wal`).size : 0);
  const stats = fs.statfsSync(os.tmpdir());
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < bytes * 2) throw new Error(`Snapshot needs about ${bytes * 2} free bytes in ${os.tmpdir()}; ${free} available`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
  fs.chmodSync(directory, 0o700);
  const destination = path.join(directory, 'agentmonitor.db');
  const db = openReadOnly(source);
  const start = performance.now();
  await db.backup(destination);
  const ms = elapsed(start);
  db.close();
  return {
    measurements: { backup_ms: ms },
    observations: { snapshot: destination, snapshot_bytes: fs.statSync(destination).size, source_bytes: bytes },
    limits: ['Remove the snapshot directory when finished; it holds a full copy of the database'],
  };
}

async function resync(options: ProbeOptions) {
  const transcript = options.transcript;
  if (!transcript || !fs.existsSync(transcript)) throw new Error('resync needs an existing transcript path');
  const { initSchema } = await import(built('db/schema.js')) as typeof Schema;
  const { getDb, closeDb } = await import(built('db/connection.js')) as typeof Connection;
  initSchema();
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(request.target!.path), 'resync must write only its scratch or snapshot database');
  const watcher = await import(built('watcher/index.js')) as typeof WatcherIndex;
  const claude = await import(built('parser/claude-code.js')) as typeof ClaudeParser;
  const codex = await import(built('parser/codex-sessions.js')) as typeof CodexParser;
  const claudeLive = await import(built('live/claude-adapter.js')) as typeof ClaudeLive;
  const codexLive = await import(built('live/codex-adapter.js')) as typeof CodexLive;
  const { safelyMaintainTraceSummaryForSession } = await import(built('trace-quality/service.js')) as typeof TraceService;

  const content = fs.readFileSync(transcript, 'utf8');
  const isCodex = transcript.includes(`${path.sep}.codex${path.sep}`) || content.slice(0, 200).includes('"session_meta"');
  const lines = content.split('\n').filter(line => line.trim()).map(line => line + '\n');
  const append = Math.min(Math.max(1, options.appendLines ?? 10), lines.length - 1);
  const prefix = lines.slice(0, lines.length - append).join('');
  const rest = lines.slice(lines.length - append).join('');
  const dir = path.join(request.evidence, 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(transcript, '.jsonl');
  const sync = isCodex ? watcher.syncCodexSessionFileDetailed : watcher.syncSessionFileDetailed;
  const countMessages = (sessionId: string) => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n;

  // End to end: the real watcher entry point on a copy that grows by an append.
  const copy = path.join(dir, `${base}.jsonl`);
  fs.writeFileSync(copy, prefix);
  let start = performance.now();
  const first = sync(db, copy);
  const prefixMs = elapsed(start);
  fs.appendFileSync(copy, rest);
  start = performance.now();
  const second = sync(db, copy);
  const appendMs = elapsed(start);

  // Phases, in the watcher's order, on a second copy with its own session id.
  const phaseId = `${base}-phases`;
  const phaseFile = path.join(dir, `${phaseId}.jsonl`);
  const phases = (text: string) => {
    fs.writeFileSync(phaseFile, text);
    const timing: Record<string, number | object> = {};
    let t = performance.now();
    const bytes = fs.readFileSync(phaseFile);
    timing.read_ms = elapsed(t);
    t = performance.now();
    createHash('sha256').update(bytes).digest('hex');
    timing.hash_ms = elapsed(t);
    t = performance.now();
    const parsed = isCodex
      ? codex.parseCodexSessionMessages(bytes.toString('utf8'), phaseId, phaseFile)
      : claude.parseSessionMessages(bytes.toString('utf8'), phaseId, phaseFile);
    timing.parse_ms = elapsed(t);
    t = performance.now();
    timing.write = claude.insertParsedSession(db, parsed, phaseFile, bytes.length, 'probe');
    timing.write_ms = elapsed(t);
    t = performance.now();
    if (isCodex) codexLive.syncCodexLiveSession(db, parsed); else claudeLive.syncClaudeLiveSession(db, parsed);
    timing.live_ms = elapsed(t);
    t = performance.now();
    safelyMaintainTraceSummaryForSession(phaseId, 'verification probe');
    timing.trace_ms = elapsed(t);
    return timing;
  };
  const prefixPhases = phases(prefix);
  const appendPhases = phases(prefix + rest);
  const observations = {
    agent: isCodex ? 'codex' : 'claude',
    transcript_bytes: Buffer.byteLength(content),
    lines: lines.length,
    appended_lines: append,
    end_to_end_results: [first.result, second.result],
    messages_after: countMessages(base),
  };
  closeDb();
  if (request.target!.kind === 'scratch') {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(request.target!.path + suffix, { force: true });
  }
  return {
    measurements: {
      end_to_end: { prefix_ms: prefixMs, append_ms: appendMs },
      phases: { prefix: prefixPhases, append: appendPhases },
    },
    observations,
    limits: [request.target!.kind === 'scratch'
      ? 'Scratch database holds only this transcript; a large store adds index and search-index cost'
      : 'Snapshot already holds the installed copy of this session, so the prefix step may trim rows before the append'],
  };
}

const handlers: Record<ProbeId, (options: ProbeOptions) => Promise<{ measurements: unknown; observations: unknown; limits?: string[] }>> = {
  health, ingestion, 'monitor-stats': monitorStats, snapshot, resync,
};
const output = await handlers[request.probe](request.options);
writeJson(path.join(request.evidence, 'worker.json'), output);
