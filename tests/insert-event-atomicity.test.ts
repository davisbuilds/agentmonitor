import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

// Isolate the DB before importing anything that reads config.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-insert-atomic-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');

function count(sql: string, ...params: unknown[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n;
}

function event(sessionId: string, agentType = 'claude_code') {
  return {
    session_id: sessionId, agent_type: agentType, event_type: 'tool_use' as const,
    tool_name: 'Bash', status: 'success' as const, tokens_in: 0, tokens_out: 0, metadata: {},
  };
}

describe('insertEvent is all-or-nothing', () => {
  before(() => {
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  });
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a failed event insert leaves no orphan session behind', () => {
    // Stand-in for any failure after the session upsert: a constraint, or
    // SQLITE_BUSY from a concurrent writer.
    getDb().exec(`CREATE TRIGGER fail_boom BEFORE INSERT ON events WHEN NEW.session_id = 'boom'
      BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`);
    try {
      assert.throws(() => insertEvent(event('boom')), /forced insert failure/);
      assert.equal(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', 'boom'), 0);
      assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', 'boom'), 0);
    } finally {
      getDb().exec('DROP TRIGGER fail_boom');
    }
  });

  test('inside a caller\'s transaction, a failed insert rolls back only itself', () => {
    getDb().exec(`CREATE TRIGGER fail_boom2 BEFORE INSERT ON events WHEN NEW.session_id = 'boom2'
      BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`);
    try {
      getDb().transaction(() => {
        insertEvent(event('outer-kept'));
        assert.throws(() => insertEvent(event('boom2')));
      })();
      assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', 'outer-kept'), 1);
      assert.equal(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', 'boom2'), 0);
    } finally {
      getDb().exec('DROP TRIGGER fail_boom2');
    }
  });

  test('a live-projection failure does not fail a write that already committed', () => {
    // The Codex live projection runs after the event commits. Its failure must
    // not surface as an error to a client whose event was in fact stored.
    getDb().exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON browsing_sessions
      BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END`);
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const row = insertEvent({ ...event('codex-projected', 'codex'), event_type: 'user_prompt' });
      assert.ok(row, 'the committed event is returned');
      assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', 'codex-projected'), 1);
      assert.ok(logged.length > 0, 'the projection failure is logged, not swallowed');
    } finally {
      console.error = originalError;
      getDb().exec('DROP TRIGGER fail_projection');
    }
  });

  test('a duplicate event_id is still skipped quietly', () => {
    const first = insertEvent({ ...event('dup'), event_id: 'same-id' });
    const second = insertEvent({ ...event('dup'), event_id: 'same-id' });
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE event_id = ?', 'same-id'), 1);
  });
});
