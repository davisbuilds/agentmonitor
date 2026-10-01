import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { startSession, stopSession } from './session.js';
import { runProbe } from './probe.js';

// Explicit opt-in: needs the compiled app (pnpm build). Fixture databases come
// from the pilot's disposable host, never the installed database.
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('probes report observations a wrong answer would contradict', { timeout: 240_000 }, async t => {
  const session = await startSession();
  const fixture = path.join(session.directory, 'fixture.db');
  try {
    await t.test('health matches a running server to its database', async () => {
      const result = await runProbe('health', { url: session.url, db: fixture });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const observations = result.observations as { server: { status: string }; listener: { pid: number } | null; target_matches_running_server: unknown };
      assert.equal(observations.server.status, 'ok');
      assert.equal(observations.target_matches_running_server, true);
      assert.ok(observations.listener && observations.listener.pid > 0);
    });
  } finally { await stopSession(session); }

  await t.test('monitor-stats times the product statements, applies its filter, and leaves the file unchanged', async () => {
    const before = digest(fixture);
    const all = await runProbe('monitor-stats', { db: fixture });
    const claude = await runProbe('monitor-stats', { db: fixture, agent: 'claude_code' });
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
    assert.equal(digest(fixture), before, 'a read probe must not modify the database');
  });

  await t.test('a probe past its deadline is killed and reported blocked', async () => {
    const result = await runProbe('monitor-stats', { db: fixture, timeoutMs: 1 });
    assert.equal(result.status, 'blocked');
    assert.match(result.errors.join(' '), /deadline/);
    const processes = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' });
    assert.ok(!processes.includes(path.join(result.directory, 'request.json')), 'the worker is gone');
  });

  await t.test('ingestion classifies each transcript against import and watcher state', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-probe-home-'));
    const previous = process.env.HOME;
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

      process.env.HOME = home;
      const result = await runProbe('ingestion', { db: copy });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const claude = (result.observations as Record<string, { discovered: number; import_state: Record<string, number>; watcher: Record<string, number> }>).claude;
      assert.equal(claude.discovered, 4);
      assert.deepEqual(claude.import_state, { unchanged: 1, changed_since_import: 1, unstamped: 1, invalidated: 0, never_imported: 1 });
      assert.deepEqual(claude.watcher, { parsed: 1, skipped: 0, error: 0, unwatched: 3 });
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
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
      const result = await runProbe('resync', { transcript, appendLines: 5 });
      assert.equal(result.status, 'observed', result.errors.join(' '));
      const append = (result.measurements as { phases: { append: { write: { messagesKept: number; messagesWritten: number } } } }).phases.append;
      assert.deepEqual(append.write, { messagesKept: 25, messagesWritten: 5 });
      const observations = result.observations as { end_to_end_results: string[]; messages_after: number };
      assert.deepEqual(observations.end_to_end_results, ['parsed', 'parsed']);
      assert.equal(observations.messages_after, 30);
      assert.equal(fs.existsSync(result.target!.path), false, 'the scratch database is removed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
