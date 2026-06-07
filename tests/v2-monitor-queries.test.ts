import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type {
  getMonitorStats as getMonitorStatsType,
  getMonitorToolStats as getMonitorToolStatsType,
  listMonitorEvents as listMonitorEventsType,
  listMonitorSessions as listMonitorSessionsType,
} from '../src/db/v2-queries.js';

let tempDir = '';
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let getMonitorToolStats: typeof getMonitorToolStatsType;
let listMonitorSessions: typeof listMonitorSessionsType;
let listMonitorEvents: typeof listMonitorEventsType;
let getMonitorStats: typeof getMonitorStatsType;
let monitorDate = '';
let monitorSince = '';
let monitorUntil = '';

function sqliteUtc(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-monitor-queries-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const queries = await import('../src/db/v2-queries.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  getMonitorToolStats = queries.getMonitorToolStats;
  listMonitorSessions = queries.listMonitorSessions;
  listMonitorEvents = queries.listMonitorEvents;
  getMonitorStats = queries.getMonitorStats;
  initSchema();

  const db = getDb();
  const now = Date.now();
  monitorDate = new Date(now).toISOString().slice(0, 10);
  monitorSince = `${monitorDate}T00:00:00Z`;
  monitorUntil = `${monitorDate}T23:59:59Z`;
  const monitorAStartedAt = new Date(now - 120_000).toISOString();
  const monitorALastEventAt = new Date(now - 30_000).toISOString();
  const monitorBStartedAt = new Date(now - 90_000).toISOString();
  const monitorBLastEventAt = new Date(now - 45_000).toISOString();
  const event1CreatedAt = sqliteUtc(now - 100_000);
  const event2CreatedAt = sqliteUtc(now - 80_000);
  const event3CreatedAt = sqliteUtc(now - 70_000);

  db.exec(`
    INSERT INTO agents (id, agent_type, name) VALUES
      ('codex-default', 'codex', 'Codex'),
      ('claude-default', 'claude_code', 'Claude')
  `);

  db.prepare(`
    INSERT INTO sessions (
      id, agent_id, agent_type, project, branch, status, started_at, last_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'monitor-a', 'codex-default', 'codex', 'alpha', 'main', 'active', monitorAStartedAt, monitorALastEventAt,
    'monitor-b', 'claude-default', 'claude_code', 'alpha', 'main', 'idle', monitorBStartedAt, monitorBLastEventAt,
  );

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, tool_name, status, tokens_in, tokens_out,
      branch, project, duration_ms, created_at, metadata, model, cost_usd, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-monitor-1', 'monitor-a', 'codex', 'tool_use', 'apply_patch', 'success', 100, 20,
    'main', 'alpha', 1200, event1CreatedAt,
    '{"file_path":"src/app.ts","lines_added":3,"lines_removed":1}', 'gpt-5.5', 0.25, 'api',
    'evt-monitor-2', 'monitor-a', 'codex', 'tool_use', 'apply_patch', 'error', 50, 5,
    'main', 'alpha', 3000, event2CreatedAt,
    '{"file_path":"src/app.ts","lines_added":2,"lines_removed":0}', 'gpt-5.5', 0.10, 'otel',
    'evt-monitor-3', 'monitor-b', 'claude_code', 'tool_use', 'Read', 'success', 80, 10,
    'main', 'alpha', 500, event3CreatedAt,
    '{}', 'claude-sonnet-4-5', 0.05, 'api',
  );
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('monitor tool stats aggregate errors, duration, and per-agent counts', () => {
  const tools = getMonitorToolStats({ project: 'alpha', date_from: '2026-06-01' });
  const patch = tools.find(tool => tool.tool_name === 'apply_patch');

  assert.ok(patch);
  assert.equal(patch.total_calls, 2);
  assert.equal(patch.error_count, 1);
  assert.equal(patch.error_rate, 0.5);
  assert.equal(patch.avg_duration_ms, 2100);
  assert.deepEqual(patch.by_agent, { codex: 2 });
});

test('monitor session and event queries apply filters, limits, and rollups', () => {
  const sessions = listMonitorSessions({
    project: 'alpha',
    exclude_status: 'ended',
    agent: 'codex',
    date_from: monitorDate,
    date_to: monitorDate,
    limit: 0,
  });
  assert.equal(sessions.total, 1);
  assert.equal(sessions.sessions[0]?.id, 'monitor-a');
  assert.equal(sessions.sessions[0]?.event_count, 2);
  assert.equal(sessions.sessions[0]?.files_edited, 1);
  assert.equal(sessions.sessions[0]?.lines_added, 5);
  assert.equal(sessions.sessions[0]?.lines_removed, 1);

  const events = listMonitorEvents({
    agent: 'codex',
    event_type: 'tool_use',
    tool_name: 'apply_patch',
    session_id: 'monitor-a',
    branch: 'main',
    model: 'gpt-5.5',
    source: 'otel',
    since: monitorSince,
    until: monitorUntil,
    limit: 5,
    offset: 0,
  });
  assert.equal(events.total, 1);
  assert.equal(events.events[0]?.event_id, 'evt-monitor-2');

  const stats = getMonitorStats({ agent: 'codex', since: monitorSince });
  assert.equal(stats.total_events, 2);
  assert.equal(stats.tool_breakdown.apply_patch, 2);
  assert.equal(stats.total_cost_usd, 0.35);
});
