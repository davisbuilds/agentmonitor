import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let server: Server;
let baseUrl: string;
let tempDir: string;
let closeDb: () => void;
const uuid = '11111111-2222-4333-8444-555555555555';
const rollout = `rollout-2026-03-01T09-00-00-${uuid}`;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-activity-'));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const connection = await import('../src/db/connection.js');
  closeDb = connection.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  const { createApp } = await import('../src/app.js');
  initSchema();
  const db = connection.getDb();
  assert.equal(db.name, dbPath);
  const browser = db.prepare(`INSERT INTO browsing_sessions
    (id, agent, integration_mode, started_at, first_message, file_path)
    VALUES (?, ?, ?, ?, 'PRIVATE PROMPT', '/private/transcript')`);
  browser.run('both', 'claude', 'claude-jsonl', '2026-03-01T09:00:00Z');
  browser.run('transcript', 'claude', 'claude-jsonl', '2026-03-01T09:00:00Z');
  browser.run(rollout, 'codex', 'codex-jsonl', '2026-03-01T09:00:00Z');
  browser.run(uuid, 'codex', 'codex-otel', '2026-03-04T09:00:00Z');
  browser.run('naive', 'antigravity', 'antigravity-sqlite', '2026-03-01T09:00:00');
  db.prepare("INSERT INTO messages (session_id, ordinal, role, content) VALUES ('transcript', 0, 'user', 'PRIVATE CONTENT')").run();
  const event = db.prepare(`INSERT INTO events
    (session_id, agent_type, event_type, source, tokens_in, client_timestamp, created_at)
    VALUES (?, ?, 'api_request', ?, ?, ?, '2026-03-02 09:00:00')`);
  event.run('both', 'claude_code', 'import', 12, '2026-03-03T09:00:00Z');
  event.run('usage-only', 'claude_code', 'api', 42, null);
  event.run('benchmark', 'claude_code', 'benchmark', 900, '2026-03-01T09:00:00Z');
  event.run(uuid, 'codex', 'otel', 100, '2026-03-04T09:00:00Z');
  event.run(uuid, 'codex', 'import', 100, '2026-03-04T09:00:00Z');
  event.run('lifecycle-only', 'claude_code', 'hook', 0, '2026-03-01T09:00:00Z');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function list(query = '') {
  const response = await fetch(`${baseUrl}/api/v2/activity/sessions${query}`);
  assert.equal(response.status, 200);
  return response.json();
}

test('activity joins telemetry and browser evidence without requiring transcripts', async () => {
  const result = await list('?agent=claude');
  assert.equal(result.total, 4);
  assert.deepEqual(result.data.map((row: { session_id: string }) => row.session_id).sort(),
    ['both', 'lifecycle-only', 'transcript', 'usage-only']);
  const only = result.data.find((row: { session_id: string }) => row.session_id === 'usage-only');
  assert.equal(only.has_usage, true);
  assert.equal(only.has_browser_history, false);
  assert.equal(only.transcript_available, false);
  assert.equal(only.started_at, '2026-03-02T09:00:00.000Z');
  assert.equal(only.time_basis, 'first_event');
  assert.equal(result.data.find((row: { session_id: string }) => row.session_id === 'transcript').transcript_available, true);
  assert.equal(result.data.find((row: { session_id: string }) => row.session_id === 'lifecycle-only').has_usage, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('/private'));
});

test('unknown Codex modes and malformed aliases are not merged with native evidence', async () => {
  const { getDb } = await import('../src/db/connection.js');
  const db = getDb();
  const malformed = `rollout-abcd-ef-ghTij-kl-mn-${uuid}`;
  try {
    db.prepare("INSERT INTO browsing_sessions (id, agent, integration_mode, started_at) VALUES (?, 'codex', 'codex-jsonl', '2026-03-01T09:00:00Z')").run(malformed);
    assert.equal((await list('?agent=codex')).total, 2);
    db.prepare("UPDATE browsing_sessions SET integration_mode = 'future-mode' WHERE id = ?").run(uuid);
    assert.equal((await list('?agent=codex')).total, 3);
  } finally {
    db.prepare('DELETE FROM browsing_sessions WHERE id = ?').run(malformed);
    db.prepare("UPDATE browsing_sessions SET integration_mode = 'codex-otel' WHERE id = ?").run(uuid);
  }
});

test('known aliases reconcile before date filtering and preserve projected date', async () => {
  const result = await list('?agent=codex');
  assert.equal(result.total, 1);
  assert.equal(result.data[0].session_id, uuid);
  assert.equal(result.data[0].has_usage, true);
  assert.equal(result.data[0].has_browser_history, true);
  assert.equal(result.data[0].started_at, '2026-03-01T09:00:00.000Z');
  assert.equal((await list('?agent=codex&date_from=2026-03-04')).total, 0);
});

test('naive source timestamps remain unresolved, and tied pages enumerate exactly once', async () => {
  const unresolved = await list('?agent=antigravity');
  assert.equal(unresolved.data[0].started_at, null);
  assert.equal(unresolved.unresolved_timestamps, 1);
  const all = await list();
  const ids: string[] = [];
  for (let offset = 0; offset < all.total; offset += 2) {
    const page = await list(`?limit=2&offset=${offset}`);
    ids.push(...page.data.map((row: { id: string }) => row.id));
  }
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  assert.equal((await list('?agent=absent')).total, 0);
});

test('invalid query parameters are rejected rather than silently reinterpreted', async () => {
  for (const query of ['limit=0', 'limit=2junk', 'offset=-1', 'date_from=garbage', 'date_from=2026-02-30', 'date_from=2026-03-02&date_to=2026-03-01']) {
    assert.equal((await fetch(`${baseUrl}/api/v2/activity/sessions?${query}`)).status, 400, query);
  }
});

test('execution receipts replay safely and never fabricate native sessions or usage', async () => {
  const { getDb } = await import('../src/db/connection.js');
  const { syncExecutionReceipts } = await import('../src/import/executions.js');
  const db = getDb();
  const spool = path.join(tempDir, 'spool');
  fs.mkdirSync(spool, { mode: 0o700 });
  const execution = {
    schema_version: 'execution.v1', execution_id: uuid, run_id: 'a'.repeat(64),
    producer: 'fixture', agent: 'antigravity', role: 'judge',
    started_at: '2026-03-01T09:00:00.000+00:00', finished_at: null as string | null,
    exit_code: null as number | null,
  };
  const file = path.join(spool, `${uuid}.json`);
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const before = (await list()).total;
  write(execution);
  assert.deepEqual(syncExecutionReceipts(db, spool), { imported: 1, unchanged: 0, errors: 0 });
  assert.deepEqual(syncExecutionReceipts(db, spool), { imported: 0, unchanged: 1, errors: 0 });
  const terminal = { ...execution, finished_at: '2026-03-01T09:02:00.000Z', exit_code: 0 };
  write(terminal);
  assert.equal(syncExecutionReceipts(db, spool).imported, 1);
  write(execution);
  assert.equal(syncExecutionReceipts(db, spool).unchanged, 1, 'stale start must not roll back completion');
  const response = await fetch(`${baseUrl}/api/v2/activity/executions?agent=antigravity`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.total, 1);
  assert.equal(result.data[0].outcome, 'succeeded');
  assert.equal(result.data[0].role, 'judge');
  assert.equal((await list()).total, before, 'execution is not a native session');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events WHERE agent_type = 'antigravity'").get()?.c, 0);
  for (const invalid of [{ ...terminal, prompt: 'PRIVATE' }, { ...terminal, run_id: 'b'.repeat(64) }, { ...terminal, exit_code: 1 }]) {
    write(invalid);
    assert.equal(syncExecutionReceipts(db, spool).errors, 1);
  }
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(tempDir, 'test.db'), file);
  assert.equal(syncExecutionReceipts(db, spool).errors, 1, 'symlinks cannot redirect receipt reads');
});
