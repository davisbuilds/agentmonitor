import type * as V2Queries from '../../src/db/v2-queries.js';
import type * as WatcherIndex from '../../src/watcher/index.js';
import type * as ClaudeParser from '../../src/parser/claude-code.js';
import type * as CodexParser from '../../src/parser/codex-sessions.js';
import type * as ClaudeLive from '../../src/live/claude-adapter.js';
import type * as CodexLive from '../../src/live/codex-adapter.js';
import type * as TraceService from '../../src/trace-quality/service.js';
import type * as Connection from '../../src/db/connection.js';
import type * as Schema from '../../src/db/schema.js';
import type * as PathExcludes from '../../src/util/path-excludes.js';
import type * as Config from '../../src/config.js';
import type * as App from '../../src/app.js';
import type * as Storage from '../../src/db/storage.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { openReadOnly } from './readonly.js';
import { createCandidateIndex } from './candidate-index.js';
import { planFlags } from './plan-flags.js';
import { auditIndexes, explain, replicateSchema, type AuditStatement, type StatementOrigin } from './index-audit.js';
import { reviveParams, serializeParams } from './record-sql.js';
import { repoRoot, writeJson } from './session.js';
import { RECLAIM_COPY, SNAPSHOT_FILE, SUITE_TMP, type DatabaseTarget, type ProbeId, type ProbeOptions } from './probe.js';

const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as {
  probe: ProbeId; target: DatabaseTarget | null; options: ProbeOptions; evidence: string; snapshot_dir: string | null;
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
      // Equal sizes are not database identity evidence.
      database_size_matches: reported === null || dbBytes === null ? 'unknown' : reported === dbBytes,
      target_matches_running_server: 'unknown',
    },
  };
}

async function ingestion(probeOptions: ProbeOptions) {
  const db = openReadOnly(request.target!.path);
  const { createConfig } = await import(built('config.js')) as typeof Config;
  const { discoverSessionFiles, discoverCodexSessionFiles, findMissingSessionProjections } = await import(built('watcher/index.js')) as typeof WatcherIndex;
  const config = createConfig(process.env);
  const { normalizeExcludePatterns } = await import(built('util/path-excludes.js')) as typeof PathExcludes;
  const options = { excludePatterns: normalizeExcludePatterns(probeOptions.excludePatterns ?? config.sync.excludePatterns) };
  const claudeDir = probeOptions.claudeDir!;
  const codexHome = probeOptions.codexHome!;
  const files = {
    claude: discoverSessionFiles(claudeDir, options),
    codex: discoverCodexSessionFiles(codexHome, options),
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
  return { measurements: {}, observations: {
    discovery: { claude_dir: claudeDir, codex_home: codexHome, exclude_patterns: options.excludePatterns, matches_running_service: 'unknown' },
    ...summary, ...(recency as object),
  } };
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
      sum_statement_medians_ms: Math.round(statements.reduce((sum, entry) => sum + entry.median_ms, 0) * 100) / 100,
      statements,
    },
    observations: { filter: { agent: options.agent ?? null, since: options.since ?? null }, runs },
    limits: [runs === 1 ? 'One sample per statement, no warmup' : `${runs} samples per statement, no separate warmup`,
      'The sum of statement medians is not an endpoint latency measurement; unfiltered requests also use a product cache'],
  };
}

async function snapshot() {
  const source = request.target!.path;
  const bytes = fs.statSync(source).size + (fs.existsSync(`${source}-wal`) ? fs.statSync(`${source}-wal`).size : 0);
  const stats = fs.statfsSync(os.tmpdir());
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < bytes * 2) throw new Error(`Snapshot needs about ${bytes * 2} free bytes in ${os.tmpdir()}; ${free} available`);
  const destination = path.join(request.snapshot_dir!, SNAPSHOT_FILE);
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
  if (lines.length < 2) throw new Error(`resync needs a transcript with at least two lines (one kept, one appended); ${transcript} has ${lines.length}`);
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
  // What the watcher parses on an append once it holds a checkpoint: only the new lines.
  const parseChunk = (isCodex ? codex.parseCodexSessionChunk : claude.parseSessionChunk) as (
    content: string, sessionId: string, filePath: string, state?: unknown) => { state: unknown };
  const head = parseChunk(prefix, phaseId, phaseFile);
  const resumeStart = performance.now();
  parseChunk(rest, phaseId, phaseFile, head.state);
  appendPhases.resumed_parse_ms = elapsed(resumeStart);
  const observations = {
    agent: isCodex ? 'codex' : 'claude',
    transcript_bytes: Buffer.byteLength(content),
    lines: lines.length,
    appended_lines: append,
    end_to_end_results: [first.result, second.result],
    end_to_end_parses: [first.parse ?? null, second.parse ?? null],
    messages_after: countMessages(base),
  };
  closeDb();
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

/** Read routes the plans probe drives; ids come from the target database. */
function planRoutes(ids: { codexSession?: string; claudeSession?: string; monitorSession?: string; study?: string }): string[] {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const window = `date_from=${from}&date_to=${to}`;
  const withAgent = (prefix: string, names: string[]) => names.flatMap(name => [
    `${prefix}/${name}?${window}`, `${prefix}/${name}?${window}&agent=codex`,
  ]);
  const routes = [
    '/api/stats', '/api/events?limit=50', '/api/events?agent_type=codex&limit=50', '/api/sessions?limit=50', '/api/filter-options',
    '/api/v2/agents', '/api/v2/projects',
    ...withAgent('/api/v2/analytics', ['activity', 'agents', 'hour-of-week', 'projects', 'skills/daily', 'skills/health', 'summary', 'tools', 'top-sessions', 'velocity']),
    ...withAgent('/api/v2/usage', ['agents', 'daily', 'facets', 'models', 'models/daily', 'overview', 'projects', 'summary', 'top-sessions', 'tiers']),
    '/api/v2/monitor/stats', '/api/v2/monitor/stats?agent=codex', '/api/v2/monitor/stats?agent=claude_code',
    '/api/v2/monitor/events', '/api/v2/monitor/events?agent=codex', '/api/v2/monitor/events?agent=codex&tool_name=exec_command',
    '/api/v2/monitor/events?agent=codex&event_type=tool_use',
    '/api/v2/monitor/events?agent=claude_code&since=2026-09-01', '/api/v2/monitor/filter-options',
    '/api/v2/monitor/tools', '/api/v2/monitor/tools?agent=codex', '/api/v2/monitor/sessions', '/api/v2/monitor/sessions?agent=codex',
    '/api/v2/sessions?limit=50', '/api/v2/sessions?agent=codex&limit=50',
    '/api/v2/search?q=index&limit=20', '/api/v2/live/sessions', '/api/v2/metrics', '/api/v2/benchmarks',
    '/api/v2/trace-quality/traces?limit=20', '/api/v2/insights', '/api/v2/pins',
  ];
  if (ids.monitorSession) routes.push(`/api/v2/monitor/sessions/${encodeURIComponent(ids.monitorSession)}`);
  for (const id of [ids.codexSession, ids.claudeSession]) {
    if (!id) continue;
    const session = `/api/v2/sessions/${encodeURIComponent(id)}`;
    routes.push(session, `${session}/activity`, `${session}/messages?limit=50`, `${session}/skill-context`, `/api/v2/live/sessions/${encodeURIComponent(id)}`);
  }
  if (ids.study) routes.push(`/api/v2/benchmarks/${encodeURIComponent(ids.study)}`);
  return routes;
}

interface RecordedStatement { sql: string; params: unknown[]; route: string }
interface StatementFailure { route: string; sql: string; error: string }
const statementFailure = (entry: RecordedStatement, error: unknown): StatementFailure => ({
  route: entry.route, sql: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 300), error: String(error),
});
function coverageSummary(routes: string[], failed: Record<string, number>, statements: number, errors: StatementFailure[]) {
  const routeFailures = Object.keys(failed).length;
  return {
    scope: 'built-in route sample',
    status: routeFailures || errors.length ? 'partial' : 'complete',
    routes_attempted: routes.length, routes_succeeded: routes.length - routeFailures, routes_failed: routeFailures,
    statements_recorded: statements, statements_succeeded: statements - errors.length, statements_failed: errors.length,
  };
}


/**
 * Drive the compiled app's read routes against the snapshot and record each
 * distinct read statement (SQL and parameters) that `include` accepts. `setup`
 * runs on the app's connection after its startup migrations, before any route.
 */
async function recordRouteStatements(
  file: string,
  include: (sql: string) => boolean,
  setup?: (db: Database.Database) => void,
): Promise<{ recorded: RecordedStatement[]; routes: string[]; failed: Record<string, number> }> {
  // Record reads by wrapping the shared Statement prototype before the app loads.
  const recorded = new Map<string, RecordedStatement>();
  let route = 'startup';
  let recording = false;
  const prepare = Database.prototype.prepare;
  let wrapped = false;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    if (!wrapped) {
      wrapped = true;
      const proto = Object.getPrototypeOf(statement) as Record<string, (...args: unknown[]) => unknown>;
      for (const method of ['all', 'get', 'iterate']) {
        const original = proto[method];
        proto[method] = function (this: Database.Statement, ...args: unknown[]) {
          if (recording && this.reader && include(this.source)) {
            const key = `${this.source}\u0000${JSON.stringify(args)}`;
            if (!recorded.has(key)) recorded.set(key, { sql: this.source, params: args, route });
          }
          return original.apply(this, args);
        };
      }
    }
    return statement;
  } as typeof Database.prototype.prepare;

  const { initSchema } = await import(built('db/schema.js')) as typeof Schema;
  const { getDb, closeDb } = await import(built('db/connection.js')) as typeof Connection;
  const { createApp } = await import(built('app.js')) as typeof App;
  initSchema();
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(file), 'the app must run only on its snapshot');
  setup?.(db);
  const one = (sql: string) => (db.prepare(sql).get() as Record<string, string> | undefined);
  const routes = planRoutes({
    codexSession: one(`SELECT id FROM browsing_sessions WHERE agent = 'codex' ORDER BY started_at DESC LIMIT 1`)?.id,
    claudeSession: one(`SELECT id FROM browsing_sessions WHERE agent = 'claude' ORDER BY started_at DESC LIMIT 1`)?.id,
    monitorSession: one(`SELECT id FROM sessions ORDER BY last_event_at DESC LIMIT 1`)?.id,
    study: one(`SELECT study_id FROM events WHERE study_id IS NOT NULL LIMIT 1`)?.study_id,
  });

  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const failed: Record<string, number> = {};
  recording = true;
  for (const path of routes) {
    route = path;
    try {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(120_000) });
      await response.arrayBuffer();
      if (response.status !== 200) failed[path] = response.status;
    } catch { failed[path] = -1; }
  }
  recording = false;
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  // Saved in the recorder's format, so index-audit --corpus can include these reads.
  const corpus = path.join(request.evidence, 'sql-corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'routes.jsonl'), [...recorded.values()]
    .map(entry => JSON.stringify({ sql: entry.sql, params: serializeParams(entry.params) })).join('\n') + '\n');
  return { recorded: [...recorded.values()], routes, failed };
}

const explainOn = (db: Database.Database, sql: string, params: unknown[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail);

/** Three timed runs on a warm cache; the first is the coldest. */
function timeOn(db: Database.Database, sql: string, params: unknown[]) {
  const samples: number[] = [];
  let rows = 0;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    rows = db.prepare(sql).all(...params).length;
    samples.push(elapsed(start));
  }
  return { samples_ms: samples, median_ms: median(samples), rows };
}

/**
 * Index impact on a snapshot: drive the compiled app's read routes, record each
 * statement that touches the index's table, then compare its plan and timing
 * with the index present and dropped inside a rolled-back transaction.
 */
async function plans(options: ProbeOptions) {
  const file = request.target!.path;
  let index = options.index;
  let table = '';
  const { recorded, routes, failed } = await recordRouteStatements(file, sql => new RegExp(`\\b${table}\\b`).test(sql), db => {
    if (options.indexSql) {
      index = createCandidateIndex(db, options.indexSql);
    }
    const found = db.prepare(`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index) as { tbl_name: string } | undefined;
    if (!index || !found) throw new Error(`Index ${index ?? '(unnamed)'} not found in the snapshot`);
    table = found.tbl_name;
  });

  const raw = new Database(file);
  raw.pragma('cache_size = -64000');
  const explain = (sql: string, params: unknown[]) => explainOn(raw, sql, params).join(' | ');
  const time = (sql: string, params: unknown[]) => {
    const { samples_ms, median_ms } = timeOn(raw, sql, params);
    return { samples_ms, median_ms };
  };
  const changed: unknown[] = [];
  let unchanged = 0;
  const failures: StatementFailure[] = [];
  for (const entry of recorded) {
    try {
      const withIndex = explain(entry.sql, entry.params);
      raw.exec('BEGIN');
      raw.exec(`DROP INDEX "${index!.replaceAll('"', '""')}"`);
      const withoutIndex = explain(entry.sql, entry.params);
      if (withIndex === withoutIndex) { raw.exec('ROLLBACK'); unchanged++; continue; }
      const without = time(entry.sql, entry.params);
      raw.exec('ROLLBACK');
      const withTiming = time(entry.sql, entry.params);
      changed.push({
        route: entry.route,
        sql: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 300),
        plan_with: withIndex, plan_without: withoutIndex,
        with: withTiming, without,
      });
    } catch (error) {
      if (raw.inTransaction) raw.exec('ROLLBACK');
      failures.push(statementFailure(entry, error));
    }
  }
  raw.close();
  return {
    measurements: { statements: recorded.length, unchanged, changed },
    observations: {
      index, table, routes: routes.length, attempted_routes: routes, failed_routes: failed, compare_errors: failures,
      coverage: coverageSummary(routes, failed, recorded.length, failures),
    },
    limits: ['Each compared statement is timed three times per variant on a warm cache; the first run of each is the coldest'],
  };
}

const HOTSPOT_LIMIT = 25;

/**
 * Where the app's reads spend their time: drive the compiled app's read routes
 * on a snapshot, then time and explain every distinct statement they ran,
 * slowest first, with plan hints such as an aggregate that looks up each match.
 */
async function hotspots() {
  const file = request.target!.path;
  const { recorded, routes, failed } = await recordRouteStatements(file, () => true);
  const db = openReadOnly(file);
  db.pragma('cache_size = -64000');
  const measured: Array<{ route: string; sql: string; median_ms: number; samples_ms: number[]; rows: number; plan: string[]; flags: string[] }> = [];
  const errors: StatementFailure[] = [];
  for (const entry of recorded) {
    try {
      const plan = explainOn(db, entry.sql, entry.params);
      measured.push({
        route: entry.route,
        sql: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 300),
        ...timeOn(db, entry.sql, entry.params),
        plan,
        flags: planFlags(entry.sql, plan),
      });
    } catch (error) { errors.push(statementFailure(entry, error)); }
  }
  db.close();
  measured.sort((a, b) => b.median_ms - a.median_ms);
  const flagged: Record<string, number> = {};
  for (const entry of measured) for (const flag of entry.flags) flagged[flag] = (flagged[flag] ?? 0) + 1;
  return {
    measurements: {
      statements: measured.length,
      sum_statement_medians_ms: Math.round(measured.reduce((sum, entry) => sum + entry.median_ms, 0) * 100) / 100,
      flagged,
      slowest: measured.slice(0, HOTSPOT_LIMIT),
    },
    observations: {
      routes: routes.length, attempted_routes: routes, failed_routes: failed, errors,
      coverage: coverageSummary(routes, failed, recorded.length, errors),
    },
    limits: [
      `Lists the ${HOTSPOT_LIMIT} slowest statements; counts cover all of them`,
      'Times each statement three times on a separate read-only connection after the routes ran, so caches are warm',
      'The sum of distinct statement medians is not an endpoint or workload latency measurement',
      'Plan flags are hints for ranking, not verdicts',
    ],
  };
}

/**
 * What compaction would return: copy the database through the online backup
 * API (read-only), then run compact's own steps on the copy, a full search-index
 * optimize and a VACUUM, and compare sizes. The parent deletes the copy.
 */
async function reclaim() {
  const source = request.target!.path;
  const sourceBytes = fs.statSync(source).size;
  const walBytes = fs.existsSync(`${source}-wal`) ? fs.statSync(`${source}-wal`).size : 0;
  const stats = fs.statfsSync(request.evidence);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const needed = (sourceBytes + walBytes) * 2;
  if (free < needed) throw new Error(`Reclaim needs about ${needed} free bytes in ${request.evidence}; ${free} available`);
  const { readStorageReport } = await import(built('db/storage.js')) as typeof Storage;

  const copy = path.join(request.evidence, RECLAIM_COPY);
  const reader = openReadOnly(source);
  let start = performance.now();
  await reader.backup(copy);
  const copyMs = elapsed(start);
  reader.close();

  const db = new Database(copy);
  try {
    const current = readStorageReport(db);
    start = performance.now();
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    const optimizeMs = elapsed(start);
    start = performance.now();
    db.exec('VACUUM');
    // As compact does: in WAL mode the rewrite lands in the WAL, and the main
    // file only shrinks once a checkpoint folds it back.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const vacuumMs = elapsed(start);
    const projected = readStorageReport(db);
    return {
      measurements: {
        current: {
          database_bytes: sourceBytes,
          wal_bytes: walBytes,
          free_bytes: current.free_bytes,
          search_index_bytes: current.search_index_bytes,
        },
        projected: { database_bytes: projected.database_bytes, search_index_bytes: projected.search_index_bytes },
        reclaimable_bytes: Math.max(0, sourceBytes + walBytes - projected.database_bytes),
        copy_ms: copyMs,
        optimize_ms: optimizeMs,
        vacuum_ms: vacuumMs,
      },
      observations: { method: 'online backup copy, then FTS optimize and VACUUM on the copy' },
      limits: ['Timings are for the copy on this machine; compact also writes and validates a backup first'],
    };
  } finally {
    db.close();
  }
}

/** Run the unit test suite with the SQL recorder; its statements are the corpus. */
function recordCorpus(directory: string) {
  const start = performance.now();
  // Its own temp dir, which the parent removes even if the deadline kills the suite.
  const tmp = path.join(request.evidence, SUITE_TMP);
  fs.mkdirSync(tmp, { recursive: true });
  const run = spawnSync(process.execPath, [
    '--import', 'tsx', '--import', './scripts/verify/record-sql.ts', '--test', 'tests/*.test.ts', 'tests/codebase/*.test.ts',
  ], { cwd: repoRoot, env: { ...process.env, TMPDIR: tmp, AGENTMONITOR_RECORD_SQL_DIR: directory }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const count = (label: string) => Number(new RegExp(`^ℹ ${label} (\\d+)$`, 'm').exec(run.stdout ?? '')?.[1] ?? Number.NaN);
  return { pass: count('pass'), fail: count('fail'), exit_code: run.status, ms: elapsed(start) };
}

/** A plan test explains the shape it pins; the statement under EXPLAIN is the one that counts. */
const explainPrefix = /^\s*EXPLAIN\s+(QUERY\s+PLAN\s+)?/i;

function loadCorpus(directories: string[]) {
  const statements = new Map<string, AuditStatement>();
  let files = 0;
  let explained = 0;
  for (const directory of directories) {
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))) {
      files++;
      for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line) as { sql: string; params: string | null };
        const sql = entry.sql.replace(explainPrefix, '');
        const origin: StatementOrigin = file === 'routes.jsonl' ? 'route' : sql !== entry.sql ? 'plan_test' : 'test_run';
        const known = statements.get(sql);
        if (known) {
          if (!known.origins!.includes(origin)) known.origins!.push(origin);
          continue;
        }
        if (origin === 'plan_test') explained++;
        statements.set(sql, { sql, params: entry.params === null ? null : reviveParams(entry.params), origins: [origin] });
      }
    }
  }
  return { files, explained, statements: [...statements.values()] };
}

const dataStatement = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;
const writer = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b|\)\s*(INSERT|UPDATE|DELETE)\b/i;

/**
 * Which indexes on a table the app's statements need: plans for every corpus
 * statement on an empty copy of the schema, each index dropped in turn, after
 * checking the copy plans each statement as the real database does.
 */
async function indexAudit(options: ProbeOptions) {
  const table = options.table ?? 'events';
  if (!/^\w+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
  const recorded = path.join(request.evidence, 'sql-corpus');
  const suite = options.corpus?.length ? null : recordCorpus(recorded);
  const directories = options.corpus?.length ? options.corpus : [recorded];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) throw new Error(`No SQL corpus in ${directory}${suite ? ' (the test suite recorded nothing; see worker.log)' : ''}`);
  }
  const corpus = loadCorpus(directories);
  const mentions = new RegExp(`\\b${table}\\b`);
  const candidates = corpus.statements.filter(entry => dataStatement.test(entry.sql) && mentions.test(entry.sql));

  const live = openReadOnly(request.target!.path);
  const copyPath = path.join(request.evidence, 'schema-copy.db');
  const copy = new Database(copyPath);
  try {
    if (!live.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) throw new Error(`No table ${table} in the database`);
    replicateSchema(live, copy);

    // Control: the schema copy must plan each statement exactly as the real database does.
    const compared: AuditStatement[] = [];
    const mismatches: Array<{ sql: string; live: string[]; copy: string[] }> = [];
    const unpreparable: Array<{ sql: string; error: string }> = [];
    for (const entry of candidates) {
      let livePlan: string[];
      let copyPlan: string[];
      try {
        livePlan = explain(live, entry);
        copyPlan = explain(copy, entry);
      } catch (error) {
        unpreparable.push({ sql: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 200), error: String(error) });
        continue;
      }
      if (livePlan.join('\n') === copyPlan.join('\n')) compared.push(entry);
      else mismatches.push({ sql: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 200), live: livePlan, copy: copyPlan });
    }

    const indexBytes = new Map<string, number>();
    const sizeOf = live.prepare(`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ?`);
    const names = live.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as Array<{ name: string }>;
    for (const { name } of names) indexBytes.set(name, (sizeOf.get(name) as { bytes: number }).bytes);
    const tableBytes = (sizeOf.get(table) as { bytes: number }).bytes;

    const start = performance.now();
    const audit = auditIndexes(copy, table, compared, indexBytes);
    return {
      measurements: {
        table_bytes: tableBytes,
        index_bytes: [...indexBytes.values()].reduce((sum, bytes) => sum + bytes, 0),
        drop_set: audit.drop_set,
        drop_set_bytes: audit.drop_set_bytes,
        indexes: audit.verdicts.map(verdict => ({ ...verdict, bytes: indexBytes.get(verdict.name) ?? 0 })),
        kept_by_joint_check: audit.kept_by_joint_check,
        audit_ms: elapsed(start),
      },
      observations: {
        table,
        corpus: {
          directories, recorded_by: suite ? 'unit test suite' : '--corpus', suite,
          files: corpus.files, statements: corpus.statements.length, from_plan_tests: corpus.explained,
          table_statements: candidates.length, table_writers: candidates.filter(entry => writer.test(entry.sql)).length,
        },
        control: { compared: compared.length, mismatched: mismatches.length, unpreparable: unpreparable.length, mismatches, unpreparable_statements: unpreparable },
        schema_copy: copyPath,
      },
      limits: [
        ...(mismatches.length ? [`${mismatches.length} statements plan differently on the schema copy and are left out of the audit`] : []),
        ...(suite && suite.fail !== 0 ? ['The test suite did not pass cleanly; its corpus may be incomplete'] : []),
      ],
    };
  } finally {
    copy.close();
    live.close();
  }
}

const handlers: Record<ProbeId, (options: ProbeOptions) => Promise<{ measurements: unknown; observations: unknown; limits?: string[] }>> = {
  health, ingestion, 'monitor-stats': monitorStats, snapshot, resync, plans, hotspots, reclaim, 'index-audit': indexAudit,
};
const output = await handlers[request.probe](request.options);
writeJson(path.join(request.evidence, 'worker.json'), output);
