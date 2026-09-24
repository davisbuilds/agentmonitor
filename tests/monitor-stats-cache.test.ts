import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Monitor session expiry invalidates the shared stats snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-monitor-stats-cache-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { closeDb, getDb } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { getStatsForBroadcast, insertEvent } = await import('../src/db/queries.js');
  const { getMonitorStats, listMonitorSessions } = await import('../src/db/v2-queries.js');

  try {
    initSchema();
    insertEvent({
      event_id: 'monitor-cache-live-event',
      session_id: 'monitor-cache-session',
      agent_type: 'codex',
      event_type: 'tool_use',
      status: 'success',
      metadata: null,
    });

    const primed = getStatsForBroadcast();
    assert.equal(primed.active_sessions, 1);
    assert.equal(primed.live_sessions, 1);

    // Simulate time passing without another event write. The v2 session read is
    // the first code path to observe and persist the expired status.
    getDb().prepare(`
      UPDATE sessions
      SET last_event_at = '2000-01-01 00:00:00', status = 'active', ended_at = NULL
      WHERE id = 'monitor-cache-session'
    `).run();
    listMonitorSessions();

    const refreshed = getMonitorStats();
    assert.equal(refreshed.active_sessions, 0);
    assert.equal(refreshed.live_sessions, 0);
  } finally {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('the shared stats snapshot does not outlive the connection it was read from', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-monitor-stats-cache-reopen-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { closeDb, getDb } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { getStatsForBroadcast } = await import('../src/db/queries.js');
  const Database = (await import('better-sqlite3')).default;

  try {
    closeDb();
    initSchema();
    // `config` snapshots the path on first import, so this file's earlier test
    // chose it; getDb() has already refused the install database.
    const dbPath = getDb().name;
    assert.match(dbPath, /agentmonitor-monitor-stats-cache/);
    assert.equal(getStatsForBroadcast().total_events, 0);

    // Another writer changes the file while the connection is closed; nothing in
    // this process marks the snapshot dirty.
    closeDb();
    const other = new Database(dbPath);
    other.prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, status, tokens_in, cost_usd, source)
      VALUES ('reopen-event', 'reopen-session', 'codex', 'llm_response', 'success', 10, 0.5, 'import')
    `).run();
    other.close();

    const reopened = getStatsForBroadcast();
    assert.equal(reopened.total_events, 1);
    assert.equal(reopened.total_cost_usd, 0.5);
  } finally {
    const opened = getDb().name;
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(opened), { recursive: true, force: true });
  }
});
