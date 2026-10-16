import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-live-status-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const { listLiveSessions, getLiveSession } = await import('../src/db/v2-queries.js');
const { effectiveLiveStatus, effectiveLiveStatusSql, liveStatusFromActivity } = await import('../src/live/live-status.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (minutes: number, from = NOW) => new Date(from - minutes * 60_000).toISOString();

test('a stored live or active status is read from the last activity; an explicit end is not', () => {
  assert.equal(effectiveLiveStatus('live', ago(1), NOW), 'live');
  assert.equal(effectiveLiveStatus('live', ago(10), NOW), 'active');
  assert.equal(effectiveLiveStatus('live', ago(24 * 60), NOW), 'ended', 'a producer that went quiet a day ago');
  assert.equal(effectiveLiveStatus('active', ago(16), NOW), 'ended');
  assert.equal(effectiveLiveStatus('ended', ago(1), NOW), 'ended', 'an explicit end stays ended');
  assert.equal(effectiveLiveStatus('available', ago(24 * 60), NOW), 'available');
  assert.equal(effectiveLiveStatus(null, ago(1), NOW), null);
  assert.equal(effectiveLiveStatus('live', null, NOW), 'live', 'no activity time to derive from');
  assert.equal(effectiveLiveStatus('live', 'not a time', NOW), 'live');
});

test('the boundaries match the write-time rule: five minutes live, fifteen active', () => {
  assert.equal(liveStatusFromActivity(ago(5), NOW), 'live');
  assert.equal(liveStatusFromActivity(new Date(NOW - 5 * 60_000 - 1).toISOString(), NOW), 'active');
  assert.equal(liveStatusFromActivity(ago(15), NOW), 'active');
  assert.equal(liveStatusFromActivity(new Date(NOW - 15 * 60_000 - 1).toISOString(), NOW), 'ended');
  for (const minutes of [0, 4, 5, 6, 14, 15, 16, 600]) {
    assert.equal(effectiveLiveStatus('live', ago(minutes), NOW), liveStatusFromActivity(ago(minutes), NOW));
  }
});

test('the SQL reading agrees with the TypeScript one', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE browsing_sessions (live_status TEXT, last_item_at TEXT, ended_at TEXT)');
  const insert = db.prepare('INSERT INTO browsing_sessions VALUES (?, ?, ?)');
  const cases: Array<[string | null, string | null, string | null]> = [];
  for (const stored of ['live', 'active', 'ended', 'available', null]) {
    for (const minutes of [1, 5, 6, 10, 15, 16, 24 * 60]) cases.push([stored, ago(minutes), null]);
    cases.push([stored, null, ago(2)], [stored, null, null], [stored, 'not a time', null]);
  }
  for (const row of cases) insert.run(...row);
  const rows = db.prepare(`SELECT live_status, last_item_at, ended_at, ${effectiveLiveStatusSql('', new Date(NOW).toISOString())} AS effective
    FROM browsing_sessions`).all() as Array<{ live_status: string | null; last_item_at: string | null; ended_at: string | null; effective: string | null }>;
  for (const row of rows) {
    assert.equal(row.effective, effectiveLiveStatus(row.live_status, row.last_item_at ?? row.ended_at, NOW),
      `${row.live_status} last=${row.last_item_at} ended=${row.ended_at}`);
  }
  assert.ok(rows.some(row => row.live_status === 'live' && row.effective === 'ended'), 'the grid exercises a stale live row');
});

test('the live session list and detail read a stale live session as ended', () => {
  initSchema();
  const db = getDb();
  assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
  const insert = db.prepare(`INSERT INTO browsing_sessions (id, agent, integration_mode, started_at, live_status, last_item_at)
    VALUES (?, 'codex', 'codex-otel', ?, ?, ?)`);
  const now = Date.now();
  insert.run('quiet-since-yesterday', ago(25 * 60, now), 'live', ago(24 * 60, now));
  insert.run('working-now', ago(30, now), 'live', ago(1, now));
  insert.run('paused', ago(30, now), 'live', ago(10, now));
  insert.run('finished', ago(30, now), 'ended', ago(2, now));

  const active = listLiveSessions({ active_only: true, limit: 50 }).data.map(row => row.id).sort();
  assert.deepEqual(active, ['paused', 'working-now']);
  assert.deepEqual(listLiveSessions({ live_status: 'live', limit: 50 }).data.map(row => row.id), ['working-now']);
  assert.deepEqual(listLiveSessions({ live_status: 'ended', limit: 50 }).data.map(row => row.id).sort(), ['finished', 'quiet-since-yesterday']);
  assert.equal(listLiveSessions({ active_only: true, limit: 50 }).total, 2, 'the count agrees with the page');

  assert.equal(getLiveSession('quiet-since-yesterday')?.live_status, 'ended');
  assert.equal(getLiveSession('paused')?.live_status, 'active');
});
