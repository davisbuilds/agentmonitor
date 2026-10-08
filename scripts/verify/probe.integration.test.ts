import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { startSession, stopSession } from './session.js';
import { runProbe, snapshotPrefix } from './probe.js';

// Explicit opt-in: needs the compiled app (pnpm build). Fixture databases come
// from the pilot's disposable host, never the installed database.
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

type StatementFailure = { route: string; sql: string; error: string };
type Coverage = {
  status: string; scope: string;
  routes_attempted: number; routes_succeeded: number; routes_failed: number;
  statements_recorded: number; statements_succeeded: number; statements_failed: number;
};
type RouteObservations = {
  attempted_routes: string[]; routes: number; failed_routes: Record<string, number>; coverage: Coverage;
};
function assertCoverage(observations: RouteObservations, status: 'complete' | 'partial') {
  const { coverage, attempted_routes: routes } = observations;
  assert.equal(coverage.scope, 'built-in route sample');
  assert.equal(coverage.status, status);
  assert.ok(routes.includes('/api/v2/monitor/stats?agent=codex'));
  assert.equal(routes.length, observations.routes);
  assert.equal(coverage.routes_attempted, routes.length);
  assert.equal(coverage.routes_failed, Object.keys(observations.failed_routes).length);
  assert.equal(coverage.routes_succeeded + coverage.routes_failed, routes.length);
  assert.equal(coverage.statements_succeeded + coverage.statements_failed, coverage.statements_recorded);
  if (status === 'complete') assert.equal(coverage.routes_failed + coverage.statements_failed, 0);
}

function assertTimingName(measurements: unknown) {
  const values = measurements as Record<string, unknown>;
  assert.ok(Number.isFinite(values.sum_statement_medians_ms));
  assert.equal('total_median_ms' in values, false);
}

// Evidence and session directories outlive a run by design; the tests remove
// exactly the ones their runs report, never a prefix sweep of the temp dir.
const created = new Set<string>();
function keep<T extends { directory?: string; session?: string | null }>(result: T): T {
  for (const dir of [result.directory, result.session]) if (dir) created.add(dir);
  return result;
}
const removeCreated = () => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); };
const probe = (...args: Parameters<typeof runProbe>) => runProbe(...args).then(keep);

test('probes report observations a wrong answer would contradict', { timeout: 240_000 }, async t => {
  t.after(removeCreated);
  const session = keep(await startSession());
  const fixture = path.join(session.directory, 'fixture.db');
  try {
    await t.test('health reports size equality without claiming database identity', async () => {
      const result = await probe('health', { url: session.url, db: fixture });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const observations = result.observations as { server: { status: string }; listener: { pid: number } | null; target_matches_running_server: unknown };
      assert.equal(observations.server.status, 'ok');
      assert.notEqual(observations.target_matches_running_server, true, 'equal bytes do not establish identity');
      assert.ok(observations.listener && observations.listener.pid > 0);
      const different = path.join(session.directory, 'different.db');
      const other = new Database(different);
      other.pragma('user_version = 123');
      other.close();
      fs.truncateSync(different, fs.statSync(fixture).size);
      const mismatch = await probe('health', { url: session.url, db: different });
      assert.equal(mismatch.status, 'observed');
      assert.equal(mismatch.observations.database_size_matches, true);
      assert.equal(mismatch.observations.target_matches_running_server, 'unknown');

    });
  } finally { await stopSession(session); }

  await t.test('monitor-stats times the product statements, applies its filter, and leaves the file unchanged', async () => {
    const before = digest(fixture);
    const all = await probe('monitor-stats', { db: fixture });
    const claude = await probe('monitor-stats', { db: fixture, agent: 'claude_code' });
    assert.equal(all.status, 'observed', all.errors.join(' '));
    type Statements = { statements: Array<{ name: string; rows: number; plan: string[] }> };
    const rows = (result: typeof all) => Object.fromEntries((result.measurements as Statements).statements.map(entry => [entry.name, entry.rows]));
    assert.deepEqual(Object.keys(rows(all)), [
      'total_events', 'usage', 'active_sessions', 'total_sessions', 'live_sessions',
      'active_agents', 'tool_breakdown', 'agent_breakdown', 'model_breakdown', 'branches',
    ]);
    // The fixture's usage events are all Codex rows on one model.
    assert.equal(rows(all).model_breakdown, 1);
    assert.equal(rows(claude).model_breakdown, 0, 'the agent filter reaches the statements');
    assert.ok((all.measurements as Statements).statements.every(entry => entry.plan.length > 0));
    assertTimingName(all.measurements);
    assert.equal(digest(fixture), before, 'a read probe must not modify the database');
  });

  await t.test('a probe past its deadline is killed and reported blocked', async () => {
    const result = await probe('monitor-stats', { db: fixture, timeoutMs: 1 });
    assert.equal(result.status, 'blocked');
    assert.match(result.errors.join(' '), /deadline/);
    const processes = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' });
    assert.ok(!processes.includes(path.join(result.directory, 'request.json')), 'the worker is gone');
  });

  await t.test('the deadline also kills what the worker started', async () => {
    // index-audit's worker runs the test suite; killing only the worker would orphan it.
    const recorder = /^\S*node\s.*--import \.\/scripts\/verify\/record-sql\.ts/;
    const running = () => execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).split('\n').filter(line => recorder.test(line.trim()));
    assert.deepEqual(running(), [], 'no recorder run before the test');
    const started = (async () => {
      for (let i = 0; i < 200 && !running().length; i++) await new Promise(resolve => setTimeout(resolve, 50));
      return running().length > 0;
    })();
    const result = await probe('index-audit', { db: fixture, timeoutMs: 6_000 });
    assert.equal(await started, true, 'the suite must have started before the deadline');
    assert.equal(result.status, 'blocked');
    assert.match(result.errors.join(' '), /deadline/);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(running(), [], 'the test suite died with the worker');
    assert.equal(result.cleanup, 'complete');
    assert.equal(fs.existsSync(path.join(result.directory, 'suite-tmp')), false, 'the killed suite leaves no temp files');
  });

  await t.test('ingestion classifies each transcript against import and watcher state', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-probe-home-'));
    const previous = process.env.AGENTMONITOR_CLAUDE_DIR;
    const previousExcludes = process.env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS;
    try {
      const projects = path.join(home, '.claude', 'projects', 'proj');
      fs.mkdirSync(projects, { recursive: true });
      fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
      const transcripts = ['stamped', 'unstamped', 'new', 'touched'].map(name => {
        const file = path.join(projects, `${name}.jsonl`);
        fs.writeFileSync(file, '{}\n');
        // Discovery joins paths under HOME, so state is keyed the same way.
        return file;
      });
      const [stamped, unstamped, , touched] = transcripts;
      const copy = path.join(home, 'probe.db');
      fs.copyFileSync(fixture, copy);
      const db = new Database(copy);
      const stamp = (file: string) => fs.statSync(file, { bigint: true });
      const insert = db.prepare(`INSERT INTO import_state (file_path, file_hash, file_size, source, file_mtime)
        VALUES (?, 'hash', ?, 'claude-code', ?)`);
      insert.run(stamped, Number(stamp(stamped).size), stamp(stamped).mtimeNs.toString());
      insert.run(unstamped, Number(stamp(unstamped).size), null);
      insert.run(touched, Number(stamp(touched).size), (stamp(touched).mtimeNs - 1_000_000n).toString());
      db.prepare(`INSERT INTO watched_files (file_path, file_hash, file_mtime, status) VALUES (?, 'hash', '', 'parsed')`).run(stamped);
      db.close();

      process.env.AGENTMONITOR_CLAUDE_DIR = path.join(home, '.claude');
      process.env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS = 'excluded';
      fs.mkdirSync(path.join(projects, 'excluded'));
      fs.writeFileSync(path.join(projects, 'excluded', 'hidden.jsonl'), '{}\n');
      const result = await probe('ingestion', { db: copy, codexHome: path.join(home, '.codex') });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const claude = (result.observations as Record<string, { discovered: number; import_state: Record<string, number>; watcher: Record<string, number> }>).claude;
      assert.equal(claude.discovered, 4);
      assert.deepEqual(claude.import_state, { unchanged: 1, changed_since_import: 1, unstamped: 1, invalidated: 0, never_imported: 1 });
      assert.deepEqual(claude.watcher, { parsed: 1, skipped: 0, error: 0, unwatched: 3 });
      assert.deepEqual(result.observations.discovery, {
        claude_dir: path.join(home, '.claude'), codex_home: path.join(home, '.codex'),
        exclude_patterns: ['excluded'], matches_running_service: 'unknown',
      });
      // Explicit scope wins over the caller's environment and can clear exclusions.
      const override = await probe('ingestion', {
        db: copy, claudeDir: path.join(home, '.claude'), codexHome: path.join(home, '.codex'), excludePatterns: [],
      });
      assert.equal((override.observations.claude as { discovered: number }).discovered, 5);
      const emptyRoot = path.join(home, 'empty');
      fs.mkdirSync(path.join(emptyRoot, 'projects'), { recursive: true });
      const empty = await probe('ingestion', { db: copy, claudeDir: emptyRoot, codexHome: path.join(home, '.codex') });
      assert.equal((empty.observations.claude as { discovered: number }).discovered, 0);
      const fromCli = keep(JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx', 'scripts/verify/cli.ts', 'probe', 'ingestion', '--db', copy,
        '--claude-dir', path.join(home, '.claude'), '--codex-home', path.join(home, '.codex'),
        '--exclude', 'excluded', '--exclude', 'new.jsonl', '--json',
      ], { encoding: 'utf8' })));
      assert.equal(fromCli.status, 'observed');
      assert.equal(fromCli.observations.claude.discovered, 3);
      assert.deepEqual(fromCli.observations.discovery.exclude_patterns, ['excluded', 'new.jsonl']);


    } finally {
      if (previous === undefined) delete process.env.AGENTMONITOR_CLAUDE_DIR; else process.env.AGENTMONITOR_CLAUDE_DIR = previous;
      if (previousExcludes === undefined) delete process.env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS; else process.env.AGENTMONITOR_SYNC_EXCLUDE_PATTERNS = previousExcludes;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test('resync keeps the prefix and writes only the appended messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-probe-transcript-'));
    try {
      const transcript = path.join(dir, 'probe-resync.jsonl');
      const lines = Array.from({ length: 30 }, (_, index) => JSON.stringify({
        type: index % 2 ? 'assistant' : 'user', sessionId: 'probe-resync', cwd: '/probe',
        timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString(),
        message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `message ${index}` }] },
      })).join('\n') + '\n';
      fs.writeFileSync(transcript, lines);
      const result = await probe('resync', { transcript, appendLines: 5 });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const append = (result.measurements as { phases: { append: { write: { messagesKept: number; messagesWritten: number } } } }).phases.append;
      assert.deepEqual(append.write, { messagesKept: 25, messagesWritten: 5 });
      const observations = result.observations as { end_to_end_results: string[]; end_to_end_parses: string[]; messages_after: number };
      assert.deepEqual(observations.end_to_end_results, ['parsed', 'parsed']);
      assert.deepEqual(observations.end_to_end_parses, ['full', 'resumed'], 'the append parses only the new lines');
      assert.equal(observations.messages_after, 30);
      assert.equal(fs.existsSync(result.target!.path), false, 'the scratch database is removed');
      assert.equal(fs.existsSync(path.join(result.directory, 'transcripts')), false, 'transcript copies must not survive default cleanup');
      assert.equal(result.cleanup, 'complete');
      assert.deepEqual(result.content_artifacts, []);
      const retained = await probe('resync', { transcript, appendLines: 5, retainTranscripts: true });
      assert.equal(retained.status, 'observed', retained.errors.join(' '));
      const copies = path.join(retained.directory, 'transcripts');
      assert.deepEqual(retained.content_artifacts, [copies]);
      assert.equal(fs.readdirSync(copies).length, 2);
      assert.ok(fs.readdirSync(copies).every(file => fs.readFileSync(path.join(copies, file), 'utf8') === lines));
      assert.equal(fs.existsSync(retained.target!.path), false);
      fs.rmSync(copies, { recursive: true });

      // A real SQLite error after transcript copies exist must also clean them.
      const backup = await probe('snapshot', { db: fixture });
      assert.equal(backup.status, 'observed', backup.errors.join(' '));
      const snapshot = String(backup.observations.snapshot);
      try {
        const db = new Database(snapshot);
        db.exec("CREATE TRIGGER fail_probe BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'verification write failure'); END");
        db.close();
        const failed = await probe('resync', { transcript, db: snapshot });
        assert.equal(failed.status, 'blocked');
        assert.equal(failed.cleanup, 'complete');
        assert.equal(fs.existsSync(path.join(failed.directory, 'transcripts')), false);
        assert.deepEqual(failed.content_artifacts, [fs.realpathSync(snapshot)], 'explicit snapshots are retained and labeled');
        assert.ok(fs.existsSync(snapshot));
      } finally { fs.rmSync(path.dirname(snapshot), { recursive: true }); }

      // Wait for a real copy to exist, then interrupt the worker during parsing.
      fs.writeFileSync(transcript, lines.repeat(300));
      const before = new Set(fs.readdirSync(os.tmpdir()));
      const abort = new AbortController();
      let sawCopy = false;
      const timer = setInterval(() => {
        for (const entry of fs.readdirSync(os.tmpdir())) {
          if (before.has(entry) || !entry.startsWith('agentmonitor-evidence-')) continue;
          const copies = path.join(os.tmpdir(), entry, 'transcripts');
          if (fs.existsSync(copies) && fs.readdirSync(copies).length) {
            sawCopy = true;
            abort.abort(new Error('Test interruption with transcript copy present'));
          }
        }
      }, 5);
      try {
        const interrupted = await probe('resync', { transcript, signal: abort.signal });
        assert.equal(sawCopy, true);
        assert.equal(interrupted.status, 'blocked');
        assert.match(interrupted.errors.join(' '), /interrupted/);
        assert.equal(interrupted.cleanup, 'complete');
        assert.equal(fs.existsSync(path.join(interrupted.directory, 'transcripts')), false);
        assert.equal(fs.existsSync(interrupted.target!.path), false);
      } finally { clearInterval(timer); }

      // Too short to split into a prefix and an append: refused, not a timing of nothing.
      for (const short of ['', lines.split('\n')[0] + '\n']) {
        fs.writeFileSync(transcript, short);
        const refused = await probe('resync', { transcript });
        assert.equal(refused.status, 'blocked');
        assert.match(fs.readFileSync(path.join(refused.directory, 'worker.log'), 'utf8'), /at least two lines/);
        assert.equal(refused.cleanup, 'complete');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t.test('an interrupted snapshot leaves no copy behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-snapshot-test-'));
    const seen = new Set(fs.readdirSync(os.tmpdir()));
    const fresh = () => fs.readdirSync(os.tmpdir()).filter(entry => !seen.has(entry) && entry.startsWith(snapshotPrefix));
    const abort = new AbortController();
    let sawCopy = false;
    const timer = setInterval(() => {
      if (fresh().some(entry => fs.existsSync(path.join(os.tmpdir(), entry, 'agentmonitor.db')))) {
        sawCopy = true;
        abort.abort(new Error('Test interruption with snapshot copy present'));
      }
    }, 2);
    try {
      const store = path.join(dir, 'agentmonitor.db');
      fs.copyFileSync(fixture, store);
      const grow = new Database(store);
      grow.exec(`CREATE TABLE ballast (b BLOB);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO ballast SELECT randomblob(4000) FROM n;`);
      grow.close();
      const interrupted = await probe('snapshot', { db: store, signal: abort.signal });
      assert.equal(sawCopy, true);
      assert.equal(interrupted.status, 'blocked');
      assert.equal(interrupted.cleanup, 'complete');
      assert.deepEqual(interrupted.content_artifacts, []);
      assert.deepEqual(fresh(), [], 'the partial snapshot directory is removed');

      const kept = await probe('snapshot', { db: fixture });
      assert.equal(kept.status, 'observed', kept.errors.join(' '));
      assert.equal(kept.cleanup, 'retained');
      assert.deepEqual(kept.content_artifacts, [kept.observations.snapshot]);
      assert.ok(fs.existsSync(String(kept.observations.snapshot)));
    } finally {
      clearInterval(timer);
      for (const entry of fresh()) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('plans shows which recorded reads an index changes, on a snapshot copy only', async () => {
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
    try {
      const copy = path.join(snapshot, 'agentmonitor.db');
      fs.copyFileSync(fixture, copy);
      const before = digest(fixture);
      const result = await probe('plans', { db: copy, index: 'idx_events_agent_created_order' });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      type Changed = { route: string; plan_with: string; plan_without: string };
      const measurements = result.measurements as { statements: number; unchanged: number; changed: Changed[] };
      const observations = result.observations as RouteObservations & { index: string; table: string; compare_errors: StatementFailure[] };
      assertCoverage(observations, 'complete');
      assert.deepEqual([observations.index, observations.table], ['idx_events_agent_created_order', 'events']);
      assert.deepEqual(observations.compare_errors, []);
      assert.equal(measurements.unchanged + measurements.changed.length, measurements.statements);
      // The agent-filtered feed page is the read this index exists for.
      const page = measurements.changed.find(entry => entry.route === '/api/v2/monitor/events?agent=codex'
        && entry.plan_with.includes('idx_events_agent_created_order'));
      assert.ok(page, JSON.stringify(measurements.changed.map(entry => entry.route)));
      assert.match(page.plan_without, /TEMP B-TREE FOR ORDER BY/);

      // SQLite parses a quoted name; DROP must quote it correctly on each comparison.
      const candidate = await probe('plans', { db: copy, indexSql: 'CREATE INDEX "idx_probe""candidate" ON events(branch, id)' });
      assert.equal(candidate.status, 'observed', candidate.errors.join(' '));
      assert.equal((candidate.observations as { index: string }).index, 'idx_probe"candidate');
      assert.deepEqual(candidate.observations.compare_errors, []);

      // The product pins this index with INDEXED BY. Removing it cannot produce
      // a plan: expose that missing comparison, rather than a clean no-change result.
      const pinned = await probe('plans', { db: copy, index: 'idx_events_usage_covering' });
      assert.equal(pinned.status, 'observed', pinned.errors.join(' '));
      const partial = pinned.observations as RouteObservations & { compare_errors: StatementFailure[] };
      assertCoverage(partial, 'partial');
      assert.ok(partial.compare_errors.length > 0);
      assert.equal(partial.coverage.statements_failed, partial.compare_errors.length);
      for (const failure of partial.compare_errors) {
        assert.ok(partial.attempted_routes.includes(failure.route));
        assert.ok(failure.sql.length > 0);
        assert.match(failure.error, /idx_events_usage_covering/);
      }
      assert.equal(digest(fixture), before, 'only the snapshot copy is written');
      assert.deepEqual(result.content_artifacts, [fs.realpathSync(copy)]);
    } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
  });

  await t.test('candidate SQL cannot mutate outside the snapshot or run an extra statement', async () => {
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-index-sentinel-'));
    try {
      const copy = path.join(snapshot, 'agentmonitor.db');
      fs.copyFileSync(fixture, copy);
      const sentinel = path.join(outside, 'sentinel.db');
      const db = new Database(sentinel);
      db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('unchanged')");
      db.close();
      const before = digest(sentinel);
      const sql = `CREATE INDEX idx_boundary_test ON events(branch, id);
        ATTACH DATABASE '${sentinel.replaceAll("'", "''")}' AS outside;
        UPDATE outside.sentinel SET value = 'changed'; DETACH DATABASE outside;`;
      const result = await probe('plans', { db: copy, indexSql: sql });
      assert.equal(digest(sentinel), before, 'rejected SQL must have no external side effects');
      assert.equal(result.status, 'blocked');
      const check = new Database(copy, { readonly: true });
      assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_boundary_test'").get(), undefined,
        'reject the entire input before even creating its first index');
      check.close();
    } finally {
      fs.rmSync(snapshot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('reclaim projects what compact would free, from a deleted copy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-reclaim-test-'));
    try {
      // A store with known free pages: data written, then dropped.
      const store = path.join(dir, 'agentmonitor.db');
      fs.copyFileSync(fixture, store);
      const writer = new Database(store);
      writer.exec(`CREATE TABLE filler (b BLOB);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO filler SELECT randomblob(2000) FROM n;
        DROP TABLE filler;`);
      // And dead search-index entries, from messages rewritten the way the old
      // re-sync did (automerge off keeps them in segments FTS5 never merges).
      writer.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)");
      writer.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('crisismerge', 64)");
      const insert = writer.prepare('INSERT INTO messages (session_id, ordinal, role, content) VALUES (?, ?, ?, ?)');
      for (let pass = 0; pass < 30; pass++) {
        writer.transaction(() => {
          writer.prepare("DELETE FROM messages WHERE session_id = 'reclaim-fixture'").run();
          for (let i = 0; i < 100; i++) insert.run('reclaim-fixture', i, 'user', `alpha${i % 97} bravo${(i * 7) % 89} charlie${(i * 3) % 83} delta${i}`.repeat(4));
        })();
      }
      writer.close();
      const before = digest(store);

      const result = await probe('reclaim', { db: store });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      type Sizes = { database_bytes: number; wal_bytes?: number; free_bytes?: number; search_index_bytes: number };
      const m = result.measurements as { current: Sizes; projected: Sizes; reclaimable_bytes: number };
      assert.ok(m.current.free_bytes! > 2000 * 2000 * 0.9, `free ${m.current.free_bytes}`);
      assert.ok(m.projected.database_bytes < m.current.database_bytes);
      assert.ok(m.projected.search_index_bytes * 2 <= m.current.search_index_bytes,
        `search index ${m.current.search_index_bytes} -> ${m.projected.search_index_bytes}`);
      assert.equal(m.reclaimable_bytes, m.current.database_bytes + m.current.wal_bytes! - m.projected.database_bytes);
      assert.ok(m.reclaimable_bytes >= m.current.free_bytes! * 0.9, 'the dropped data is what compact frees');
      assert.equal(result.cleanup, 'complete');
      assert.deepEqual(fs.readdirSync(result.directory).filter(name => name.startsWith('reclaim-copy')), []);
      assert.deepEqual(result.content_artifacts, []);
      assert.equal(digest(store), before, 'reclaim reads the store and writes only its copy');

      // Interrupted while the copy exists, the parent still deletes it.
      const grow = new Database(store);
      grow.exec(`CREATE TABLE ballast (b BLOB);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO ballast SELECT randomblob(4000) FROM n;`);
      grow.close();
      const seen = new Set(fs.readdirSync(os.tmpdir()));
      const abort = new AbortController();
      let sawCopy = false;
      const timer = setInterval(() => {
        for (const entry of fs.readdirSync(os.tmpdir())) {
          if (seen.has(entry) || !entry.startsWith('agentmonitor-evidence-')) continue;
          if (fs.existsSync(path.join(os.tmpdir(), entry, 'reclaim-copy.db'))) {
            sawCopy = true;
            abort.abort(new Error('Test interruption with reclaim copy present'));
          }
        }
      }, 2);
      try {
        const interrupted = await probe('reclaim', { db: store, signal: abort.signal });
        assert.equal(sawCopy, true);
        assert.equal(interrupted.status, 'blocked');
        assert.equal(interrupted.cleanup, 'complete');
        assert.deepEqual(fs.readdirSync(interrupted.directory).filter(name => name.startsWith('reclaim-copy')), []);
      } finally { clearInterval(timer); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t.test('hotspots ranks every read the routes ran, on a snapshot copy only', async () => {
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
    try {
      const copy = path.join(snapshot, 'agentmonitor.db');
      fs.copyFileSync(fixture, copy);
      const before = digest(fixture);
      const result = await probe('hotspots', { db: copy });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      type Entry = { route: string; sql: string; median_ms: number; plan: string[]; flags: string[] };
      const measurements = result.measurements as { statements: number; flagged: Record<string, number>; slowest: Entry[] };
      const observations = result.observations as RouteObservations & { errors: StatementFailure[] };
      assertCoverage(observations, 'complete');
      assertTimingName(measurements);
      assert.deepEqual(observations.errors, []);
      assert.deepEqual(observations.failed_routes, {});
      assert.ok(measurements.statements > measurements.slowest.length, 'more statements than the listed slowest');
      assert.deepEqual(measurements.slowest.map(entry => entry.median_ms), [...measurements.slowest.map(entry => entry.median_ms)].sort((a, b) => b - a));
      assert.ok(measurements.slowest.every(entry => entry.plan.length > 0));
      // Reads from more than one table are timed, not only events.
      const all = measurements.slowest.map(entry => entry.sql).join('\n');
      assert.match(all, /\bevents\b/);
      assert.match(all, /\b(messages|browsing_sessions|sessions)\b/);
      assert.equal(digest(fixture), before, 'only the snapshot copy is written');
      assert.deepEqual(result.content_artifacts, [fs.realpathSync(copy)]);
    } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
  });

  await t.test('failed routes make coverage partial without discarding the successful observations', async () => {
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
    try {
      const copy = path.join(snapshot, 'agentmonitor.db');
      fs.copyFileSync(fixture, copy);
      const db = new Database(copy);
      db.exec(`INSERT INTO sessions (id, agent_id, agent_type, status, last_event_at)
        VALUES ('coverage-failure', 'probe', 'codex', 'active', '2000-01-01');
        CREATE TRIGGER fail_idle_session BEFORE UPDATE ON sessions
        BEGIN SELECT RAISE(ABORT, 'verification route failure'); END;`);
      db.close();
      const result = await probe('hotspots', { db: copy });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const observations = result.observations as RouteObservations;
      assertCoverage(observations, 'partial');
      assert.equal(observations.failed_routes['/api/stats'], 500);
      assert.ok(observations.coverage.routes_succeeded > 0);
      assert.ok(observations.coverage.statements_succeeded > 0);
    } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
  });

  await t.test('index-audit classifies indexes from a corpus without writing the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-index-audit-test-'));
    try {
      const store = path.join(dir, 'agentmonitor.db');
      fs.copyFileSync(fixture, store);
      const writer = new Database(store);
      writer.exec('CREATE INDEX idx_probe_unused ON events(duration_ms)');
      writer.close();
      const before = digest(store);
      const corpus = path.join(dir, 'corpus');
      fs.mkdirSync(corpus);
      const line = (sql: string, params: unknown[] | null) => JSON.stringify({ sql, params: params && JSON.stringify(params) });
      fs.writeFileSync(path.join(corpus, '1.jsonl'), [
        line('SELECT id FROM events WHERE tool_name = ?', ['Edit']),
        line('EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT ?', ['s', 5]),
        line("UPDATE events SET cost_usd = ?, cost_source = 'estimated' WHERE id = ?", [1, 2]),
        line('SELECT COUNT(*) FROM sessions', []),
      ].join('\n') + '\n');

      const result = await probe('index-audit', { db: store, corpus: [corpus] });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      type Verdict = { name: string; verdict: string; bytes: number };
      const m = result.measurements as { indexes: Verdict[]; drop_set: string[] };
      const o = result.observations as {
        corpus: { statements: number; from_plan_tests: number; table_statements: number; table_writers: number };
        control: { compared: number; mismatched: number }; schema_copy: string;
      };
      assert.deepEqual(o.corpus, { ...o.corpus, statements: 4, from_plan_tests: 1, table_statements: 3, table_writers: 1 });
      assert.deepEqual(o.control, { ...o.control, compared: 3, mismatched: 0 }, 'the schema copy plans like the real database');
      const verdict = (name: string) => m.indexes.find(index => index.name === name)?.verdict;
      assert.equal(verdict('idx_probe_unused'), 'unused');
      assert.ok(m.drop_set.includes('idx_probe_unused'));
      assert.equal(verdict('idx_events_tool_name'), 'needed', 'without it the tool lookup scans');
      assert.ok(!m.drop_set.includes('idx_events_tool_name'));
      assert.ok(m.indexes.every(index => index.bytes >= 0));
      const copy = new Database(o.schema_copy, { readonly: true });
      try {
        assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0, 'the copy has no rows');
      } finally { copy.close(); }
      assert.equal(digest(store), before, 'index-audit reads the database only');

      const invalid = await probe('index-audit', { db: store, corpus: [corpus], table: 'events; DROP TABLE events' });
      assert.equal(invalid.status, 'blocked');
      assert.equal(digest(store), before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
