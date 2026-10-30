import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-project-repair-scratch-')));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { repairProjectNames } = await import('../src/import/project-repair.js');
const { setScratchRootsForTests } = await import('../src/util/project-identity.js');

// A session run in a scratch directory since removed, stored under its
// folder's name by the import, the hooks, and the session browser.
const scratch = path.join(tempDir, 'scratch');
const run = path.join(scratch, 'tm-terra.g35Rbg');
const claudeDir = path.join(tempDir, 'claude');
const ID = 'c0ffee00-0000-4000-8000-0000000000aa';

before(() => {
  setScratchRootsForTests([scratch]);
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  const file = path.join(claudeDir, 'projects', '-scratch-tm-terra-g35Rbg', `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    type: 'user', sessionId: ID, cwd: run, timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: 'hi' },
  }));
  const db = getDb();
  const event = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, status, project, source, created_at)
    VALUES (?, 'claude_code', 'response', 'success', ?, ?, '2026-10-05 10:00:00')`);
  event.run(ID, 'tm-terra.g35Rbg', 'import');
  event.run(ID, 'tm-terra.g35Rbg', 'hook');
  db.prepare(`INSERT INTO sessions (id, agent_id, agent_type, project, status, last_event_at)
    VALUES (?, 'a', 'claude_code', 'tm-terra.g35Rbg', 'ended', '2026-10-05 10:00:00')`).run(ID);
  db.prepare(`INSERT INTO browsing_sessions (id, agent, project) VALUES (?, 'claude', 'tm-terra.g35Rbg')`).run(ID);
});

after(() => {
  setScratchRootsForTests(null);
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('repair clears the project of scratch work everywhere it was stored', () => {
  const report = repairProjectNames(getDb(), { claudeDir, codexDir: path.join(tempDir, 'codex'), apply: true });
  assert.deepEqual(report.rows, { events: 2, sessions: 1, browsing_sessions: 1 });
  assert.deepEqual(report.renames, [{ from: 'tm-terra.g35Rbg', to: null, sessions: 1 }]);
  const db = getDb();
  for (const table of ['events', 'sessions', 'browsing_sessions']) {
    const projects = (db.prepare(`SELECT project FROM ${table}`).all() as Array<{ project: string | null }>).map(row => row.project);
    assert.ok(projects.every(project => project === null), `${table} still names ${JSON.stringify(projects)}`);
  }
});
