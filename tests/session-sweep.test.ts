import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import type Database from 'better-sqlite3';
import type * as QueriesModule from '../src/db/queries.js';
import type { SessionSweep } from '../src/db/queries.js';

let tempDir = '';
let dbPath = '';
let getDb: () => Database.Database;
let closeDb: () => void;
let queries: typeof QueriesModule;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-sweep-'));
  dbPath = path.join(tempDir, 'sweep.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const { initSchema } = await import('../src/db/schema.js');
  const connection = await import('../src/db/connection.js');
  getDb = connection.getDb as () => Database.Database;
  closeDb = connection.closeDb;
  queries = await import('../src/db/queries.js');
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  assert.equal(db.name, dbPath);
  db.exec('DELETE FROM sessions');
});

function seed(id: string, status: string, minutesAgo: number): void {
  getDb().prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, status, started_at, last_event_at)
    VALUES (?, 'agent', 'claude_code', ?, datetime('now', '-1 day'), datetime('now', ?))
  `).run(id, status, `-${minutesAgo} minutes`);
}

function statusOf(id: string): string {
  return (getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string }).status;
}

test('the sweep reports each session it moved and the status it left it in', () => {
  seed('fresh', 'active', 1);
  seed('quiet', 'active', 7);      // past one timeout: idle
  seed('gone', 'idle', 12);        // past two timeouts: ended
  seed('long-gone', 'active', 30); // both steps in one sweep: ended
  seed('done', 'ended', 60);

  const sweep = queries.updateIdleSessions(5);

  assert.deepEqual(
    [...sweep.transitions].sort((a, b) => a.session_id.localeCompare(b.session_id)),
    [
      { session_id: 'gone', status: 'ended' },
      { session_id: 'long-gone', status: 'ended' },
      { session_id: 'quiet', status: 'idle' },
    ],
  );
  assert.equal(sweep.idled, 2);
  assert.equal(sweep.ended, 2);
  assert.equal(statusOf('fresh'), 'active');
  assert.equal(statusOf('done'), 'ended');
});

test('a sweep that only ends sessions still reaches listeners, whichever caller ran it', () => {
  seed('gone', 'idle', 12);
  const heard: SessionSweep[] = [];
  const stop = queries.onSessionSweep(sweep => heard.push(sweep));
  try {
    // A read runs the sweep before the periodic check does.
    queries.getSessions({ excludeStatus: 'ended', limit: 10 });
    assert.equal(heard.length, 1);
    assert.deepEqual(heard[0].transitions, [{ session_id: 'gone', status: 'ended' }]);

    // Nothing left to move: listeners stay quiet.
    queries.updateIdleSessions(5);
    assert.equal(heard.length, 1);
  } finally {
    stop();
  }
});
