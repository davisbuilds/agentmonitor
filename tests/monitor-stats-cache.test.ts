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
