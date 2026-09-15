import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { closeDb as closeDbType } from '../src/db/connection.js';
import type { BrowsingSessionRow } from '../src/api/v2/types.js';

let server: Server;
let baseUrl: string;
let tempDir: string;
let closeDb: typeof closeDbType;
const uuid = '11111111-2222-4333-8444-555555555555';
const rollout = `rollout-2026-03-01T09-00-00-${uuid}`;
const secondRollout = `rollout-2026-03-02T09-00-00-${uuid}`;
const solo = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-session-identity-'));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  const { createApp } = await import('../src/app.js');
  initSchema();
  const db = dbModule.getDb();
  assert.equal(db.name, dbPath);
  const insert = db.prepare(`INSERT INTO browsing_sessions
    (id, agent, integration_mode, project, started_at, message_count, file_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run(uuid, 'codex', 'codex-import', 'summary-project', '2026-03-03T10:00:00Z', 800, null);
  insert.run(rollout, 'codex', 'codex-jsonl', 'transcript-project', '2026-03-01T09:00:00Z', 20, '/synthetic/first.jsonl');
  insert.run(secondRollout, 'codex', 'codex-jsonl', 'transcript-project', '2026-03-02T09:00:00Z', 10, '/synthetic/second.jsonl');
  insert.run(solo, 'codex', 'codex-otel', 'solo-project', '2026-03-01T09:00:00Z', 3, null);
  // Neither other providers nor arbitrary IDs are evidence of a Codex alias.
  insert.run(`other-${uuid}`, 'claude', 'claude-jsonl', 'controls', '2026-03-01T09:00:00Z', 2, null);
  insert.run(`custom-${uuid}`, 'codex', 'codex-jsonl', 'controls', '2026-03-01T09:00:00Z', 2, null);
  insert.run(`rollout-2026-03-01T09-00-00-${solo}`, 'codex', 'future-mode', 'controls', '2026-03-01T09:00:00Z', 2, null);
  const invalid = 'zzzzzzzz-2222-4333-8444-555555555555';
  insert.run(invalid, 'codex', 'codex-import', 'controls', '2026-03-01T09:00:00Z', 2, null);
  insert.run(`rollout-2026-03-01T09-00-00-${invalid}`, 'codex', 'codex-jsonl', 'controls', '2026-03-01T09:00:00Z', 2, null);
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function list(query = ''): Promise<{ data: BrowsingSessionRow[]; total: number; cursor?: string }> {
  const response = await fetch(`${baseUrl}/api/v2/sessions${query}`);
  assert.equal(response.status, 200);
  return response.json();
}

test('session list prefers the richest transcript once per known Codex identity, preserving controls', async () => {
  const result = await list();
  assert.equal(result.total, 7);
  assert.equal(result.data.length, 7);
  assert.ok(result.data.some(row => row.id === rollout));
  assert.ok(result.data.some(row => row.id === solo), 'summary-only conversations remain visible');
  assert.ok(!result.data.some(row => row.id === uuid || row.id === secondRollout));
  assert.equal((await list('?project=controls')).total, 5);
});

test('identity selection precedes dates, projects, message filters and cursor pagination', async () => {
  assert.equal((await list('?date_from=2026-03-03')).total, 0, 'later summary must not reappear');
  assert.equal((await list('?project=summary-project')).total, 0);
  assert.equal((await list('?min_messages=100')).total, 0);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(result.total, 7);
    ids.push(...result.data.map(row => row.id));
    cursor = result.cursor;
    assert.ok(ids.length <= 7, 'pagination must terminate without duplicates');
  } while (cursor);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
});

test('original projection detail URLs remain accessible without changing stored history', async () => {
  for (const id of [uuid, rollout, secondRollout]) {
    const response = await fetch(`${baseUrl}/api/v2/sessions/${id}`);
    assert.equal(response.status, 200);
  }
  const { getDb } = await import('../src/db/connection.js');
  assert.deepEqual(getDb().prepare('SELECT COUNT(*) AS count FROM browsing_sessions').get(), { count: 9 });
});

test('OTEL aliases reconcile just like import aliases, without treating unknown modes as proof', async () => {
  const { getDb } = await import('../src/db/connection.js');
  const update = getDb().prepare('UPDATE browsing_sessions SET integration_mode = ? WHERE id = ?');
  try {
    update.run('codex-otel', uuid);
    assert.equal((await list()).total, 7);
    update.run('future-mode', uuid);
    assert.equal((await list()).total, 8);
    assert.ok((await list()).data.some(row => row.id === uuid));
  } finally {
    update.run('codex-import', uuid);
  }
});
