import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-read-surface-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { createApp } = await import('../src/app.js');

let server: Server;
let baseUrl = '';

async function getJson<T>(route: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${route}`);
  return { status: res.status, body: await res.json() as T };
}

function seedBrowsingSession(id: string, startedAt: string, messages = 1): void {
  getDb().prepare(`
    INSERT INTO browsing_sessions (id, project, agent, started_at, ended_at, message_count, user_message_count)
    VALUES (?, 'read-surface', 'claude', ?, ?, ?, 0)
  `).run(id, startedAt, startedAt, messages);
}

before(async () => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));

  insertEvent({
    session_id: 'real-session', agent_type: 'claude_code', event_type: 'llm_response',
    status: 'success', tokens_in: 10, tokens_out: 5, source: 'hook',
  });
  insertEvent({
    session_id: 'bench-session', agent_type: 'claude_code', event_type: 'llm_response',
    status: 'success', tokens_in: 10, tokens_out: 5, source: 'benchmark',
  });
  // More sessions than the list ceiling, so an unbounded read is observable.
  for (let i = 0; i < 505; i++) {
    insertEvent({
      session_id: `bulk-session-${i}`, agent_type: 'codex', event_type: 'tool_use',
      status: 'success', source: 'hook',
    });
  }

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('benchmark rows stay out of the Monitor feed and session list', () => {
  test('the default event feed omits benchmark rows', async () => {
    const { body } = await getJson<{ events: Array<{ session_id: string }>; total: number }>(
      '/api/v2/monitor/events?limit=500&agent=claude_code',
    );
    const sessions = body.events.map(e => e.session_id);
    assert.ok(sessions.includes('real-session'));
    assert.ok(!sessions.includes('bench-session'));
    assert.equal(body.total, body.events.length);
  });

  test('an explicit source=benchmark filter still returns them', async () => {
    const { body } = await getJson<{ events: Array<{ session_id: string }> }>(
      '/api/v2/monitor/events?source=benchmark',
    );
    assert.deepEqual(body.events.map(e => e.session_id), ['bench-session']);
  });

  test('the session list omits sessions made only of benchmark rows', async () => {
    const { body } = await getJson<{ sessions: Array<{ id: string }> }>('/api/v2/monitor/sessions?limit=0&agent=claude_code');
    const ids = body.sessions.map(s => s.id);
    assert.ok(ids.includes('real-session'));
    assert.ok(!ids.includes('bench-session'));
  });
});

describe('monitor session list limit', () => {
  test('limit=0 and negative limits are capped at the ceiling, not unbounded or clamped to one', async () => {
    // The Monitor page asks for limit=0 to mean "every live session", so a
    // clamp to 1 would silently truncate it; the fix is a ceiling.
    for (const limit of ['0', '-1', '100000']) {
      const { body } = await getJson<{ sessions: unknown[] }>(`/api/v2/monitor/sessions?limit=${limit}`);
      assert.equal(body.sessions.length, 500, `limit=${limit}`);
    }
  });

  test('a positive limit below the ceiling is honored', async () => {
    const { listMonitorSessions, MONITOR_SESSIONS_MAX_LIMIT } = await import('../src/db/v2-queries.js');
    assert.equal(MONITOR_SESSIONS_MAX_LIMIT, 500);
    assert.equal(listMonitorSessions({ limit: 5 }).sessions.length, 5);
  });
});

describe('usage and analytics reject unparseable dates', () => {
  for (const route of ['/api/v2/usage/summary', '/api/v2/analytics/summary', '/api/v2/usage/daily']) {
    test(`${route} returns 400 for an unparseable date instead of $0`, async () => {
      for (const query of ['date_from=not-a-date', 'date_to=2026-13-45', 'date_from=2026-02-30']) {
        const { status } = await getJson(`${route}?${query}`);
        assert.equal(status, 400, `${route}?${query}`);
      }
    });
  }

  test('bare dates and the ISO timestamps the Monitor sends are accepted', async () => {
    for (const query of ['date_from=2026-09-01&date_to=2026-09-22', 'date_from=2026-09-15T12:34:56.789Z']) {
      const { status } = await getJson(`/api/v2/usage/summary?${query}`);
      assert.equal(status, 200, query);
    }
  });
});

describe('date_to covers the whole calendar day across DST', () => {
  test('a session late on a spring-forward day is inside date_to under a US zone', async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      seedBrowsingSession('dst-session', '2026-03-08T23:30:00Z');
      const { listBrowsingSessions } = await import('../src/db/v2-queries.js');
      const result = listBrowsingSessions({ project: 'read-surface', date_to: '2026-03-08' });
      assert.ok(result.data.some(s => s.id === 'dst-session'));
    } finally {
      process.env.TZ = previousTz;
    }
  });
});

describe('Hour-of-Week buckets by local time, matching its label', () => {
  test('a UTC early-morning session lands on the previous local evening', async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2026-09-11 02:00Z is Friday 02:00 UTC but Thursday 22:00 EDT.
      seedBrowsingSession('how-session', '2026-09-11T02:00:00Z', 7);
      const { getAnalyticsHourOfWeek } = await import('../src/db/v2-queries.js');
      const grid = getAnalyticsHourOfWeek({ project: 'read-surface' });
      // day_of_week is Monday=0, so Thursday is 3 and Friday is 4.
      const thursday22 = grid.find(p => p.day_of_week === 3 && p.hour_of_day === 22);
      const friday02 = grid.find(p => p.day_of_week === 4 && p.hour_of_day === 2);
      assert.equal(thursday22?.message_count, 7);
      assert.equal(friday02?.message_count, 0);
    } finally {
      process.env.TZ = previousTz;
    }
  });
});
