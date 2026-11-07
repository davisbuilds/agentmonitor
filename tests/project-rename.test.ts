import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-project-rename-')));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { renameStoredProjects } = await import('../src/import/project-repair.js');
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');

// No transcript backs any of these sessions: the list is the only evidence.
const JOB = 'job-session';
const SCRATCH = 'scratch-session';
const BROWSER_ONLY = 'browser-only-session';
const KEPT = 'kept-session';

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  const db = getDb();
  const event = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, status, project, source, created_at)
    VALUES (?, 'claude_code', 'response', 'success', ?, 'import', '2026-05-18 10:00:00')`);
  event.run(JOB, 'feed-code-coverage-backfill-feed-2026-05-05');
  event.run(JOB, 'feed-code-coverage-backfill-feed-2026-05-05');
  event.run(SCRATCH, 'tmp');
  event.run(KEPT, 'feed');
  // A name that only contains a listed one is not that name.
  event.run(KEPT, 'tmp-notes');
  const session = db.prepare(`INSERT INTO sessions (id, agent_id, agent_type, project, status, last_event_at) VALUES (?, 'a', 'claude_code', ?, 'ended', '2026-05-18 10:00:00')`);
  session.run(JOB, 'feed-code-coverage-backfill-feed-2026-05-05');
  session.run(SCRATCH, 'tmp');
  const browser = db.prepare('INSERT INTO browsing_sessions (id, agent, project) VALUES (?, ?, ?)');
  browser.run(SCRATCH, 'claude', 'tmp');
  browser.run(BROWSER_ONLY, 'claude', 'site-code-coverage-backfill-site-2026-06-10');
  for (const id of [JOB, SCRATCH, BROWSER_ONLY, KEPT]) maintainSessionTraceSummary(id);
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const projects = (table: string, idColumn: string, id: string) => getDb()
  .prepare(`SELECT project FROM ${table} WHERE ${idColumn} = ? ORDER BY rowid`).all(id)
  .map(row => (row as { project: string | null }).project);

const NAMES: Array<[string, string | null]> = [
  ['feed-code-coverage-backfill-feed-2026-05-05', 'feed'],
  ['site-code-coverage-backfill-site-2026-06-10', 'site.net'],
  ['tmp', null],
  ['not-stored-anywhere', null],
];

test('a preview counts what the list would change and writes nothing', () => {
  const report = renameStoredProjects(getDb(), { names: NAMES, apply: false });
  assert.equal(report.apply, false);
  assert.equal(report.sessions_changed, 3);
  assert.deepEqual(report.rows, { events: 3, sessions: 2, browsing_sessions: 2 });
  assert.deepEqual(projects('events', 'session_id', JOB), ['feed-code-coverage-backfill-feed-2026-05-05', 'feed-code-coverage-backfill-feed-2026-05-05']);
  assert.deepEqual(projects('session_trace_summary', 'session_id', SCRATCH), ['tmp']);
});

test('applying renames or clears exactly the listed names in every table, once', () => {
  const report = renameStoredProjects(getDb(), { names: NAMES, apply: true });
  assert.deepEqual(report.rows, { events: 3, sessions: 2, browsing_sessions: 2 });
  assert.deepEqual(report.renames, [
    { from: 'feed-code-coverage-backfill-feed-2026-05-05', to: 'feed', sessions: 1 },
    { from: 'site-code-coverage-backfill-site-2026-06-10', to: 'site.net', sessions: 1 },
    { from: 'tmp', to: null, sessions: 1 },
  ]);

  assert.deepEqual(projects('events', 'session_id', JOB), ['feed', 'feed']);
  assert.deepEqual(projects('sessions', 'id', JOB), ['feed']);
  assert.deepEqual(projects('events', 'session_id', SCRATCH), [null]);
  assert.deepEqual(projects('sessions', 'id', SCRATCH), [null]);
  assert.deepEqual(projects('browsing_sessions', 'id', SCRATCH), [null]);
  assert.deepEqual(projects('browsing_sessions', 'id', BROWSER_ONLY), ['site.net']);
  // Trace summaries follow their sessions.
  assert.deepEqual(projects('session_trace_summary', 'session_id', JOB), ['feed']);
  assert.deepEqual(projects('session_trace_summary', 'session_id', SCRATCH), [null]);
  assert.deepEqual(projects('session_trace_summary', 'session_id', BROWSER_ONLY), ['site.net']);
  // Unlisted names stay, including one that only contains a listed name.
  assert.deepEqual(projects('events', 'session_id', KEPT), ['feed', 'tmp-notes']);

  const again = renameStoredProjects(getDb(), { names: NAMES, apply: true });
  assert.deepEqual(again.rows, { events: 0, sessions: 0, browsing_sessions: 0 });
  assert.equal(again.sessions_changed, 0);
});
