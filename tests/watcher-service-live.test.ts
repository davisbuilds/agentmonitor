import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before, describe } from 'node:test';
import Database from 'better-sqlite3';

import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { startWatcher as startWatcherFn, stopWatcher as stopWatcherFn } from '../src/watcher/service.js';
import type { broadcaster as broadcasterType } from '../src/sse/emitter.js';
import type { createApp as createAppFn } from '../src/app.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-watcher-live-'));
process.env.AGENTMONITOR_DB_PATH = path.join(root, 'test.db');

const claudeDir = path.join(root, 'claude');
const codexHome = path.join(root, 'codex');
const antigravityDir = path.join(root, 'antigravity');
const antigravityConversationsDir = path.join(antigravityDir, 'conversations');
const projectDir = path.join(claudeDir, 'projects', '-proj');

let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let startWatcher: typeof startWatcherFn;
let stopWatcher: typeof stopWatcherFn;
let broadcaster: typeof broadcasterType;
let createApp: typeof createAppFn;

function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let b = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) b |= 0x80;
    out.push(b);
  } while (big > 0);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const vField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];
const lField = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const sField = (f: number, s: string) => lField(f, [...Buffer.from(s, 'utf-8')]);
const stepBlob = (type: number, oneof: number) =>
  Buffer.from([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, [...vField(1, 1)])]);
const metaBlob = (secs: number) => Buffer.from(lField(1, [...vField(1, secs)]));
const genBlob = (model: string, prompt: number) =>
  Buffer.from(lField(1, [
    ...sField(19, model),
    ...lField(4, [...vField(1, 0), ...vField(2, prompt), ...vField(3, 10), ...vField(5, 0), ...vField(9, 0), ...vField(10, 10)]),
  ]));

function seedRow(id: string): void {
  getDb().prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata)
    VALUES (?, 'claude_code-default', 'claude_code', 'proj', 'main', 'active', datetime('now'), datetime('now'), '{}')
  `).run(id);
}

function modeOf(id: string): string | null {
  const row = getDb().prepare("SELECT json_extract(metadata, '$.mode') AS mode FROM sessions WHERE id = ?").get(id) as { mode: string | null } | undefined;
  return row?.mode ?? null;
}

before(async () => {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(antigravityConversationsDir, { recursive: true });

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const svc = await import('../src/watcher/service.js');
  startWatcher = svc.startWatcher;
  stopWatcher = svc.stopWatcher;
  ({ broadcaster } = await import('../src/sse/emitter.js'));
  ({ createApp } = await import('../src/app.js'));
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
});

after(async () => {
  broadcaster?.closeAllClients();
  await stopWatcher();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('watcher picks up live file changes (chokidar directory watch, not globs)', () => {
  test('a newly written headless JSONL is parsed and its session marked', async () => {
    const id = 'live-w-headless';
    seedRow(id);

    startWatcher({ claudeDir, codexHome, antigravityDir });
    await delay(600);

    fs.writeFileSync(
      path.join(projectDir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', sessionId: id, entrypoint: 'sdk-cli', promptSource: 'sdk', cwd: '/tmp/proj',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, timestamp: '2026-07-07T10:00:00Z' }),
        JSON.stringify({ type: 'assistant', sessionId: id, entrypoint: 'sdk-cli', cwd: '/tmp/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'claude-haiku-4-5-20251001' }, timestamp: '2026-07-07T10:00:01Z' }),
      ].join('\n') + '\n',
    );

    let mode: string | null = null;
    for (let i = 0; i < 50; i++) {
      mode = modeOf(id);
      if (mode !== null) break;
      await delay(100);
    }
    assert.equal(mode, 'headless');
  });

  test('Antigravity .db and .db-wal changes sync live and broadcast session_update', async () => {
    const id = 'live-agr-watch-1';
    const dbPath = path.join(antigravityConversationsDir, `${id}.db`);
    const updates: Array<{ event: string; data: string }> = [];
    const fakeRes = {
      writableEnded: false,
      destroyed: false,
      writeHead: () => fakeRes,
      write: (chunk: string) => {
        updates.push({ event: 'chunk', data: chunk });
        return true;
      },
      on: () => fakeRes,
      off: () => fakeRes,
      once: () => fakeRes,
      end: () => {},
    };
    broadcaster.addClient(fakeRes as unknown as Parameters<typeof broadcaster.addClient>[0]);

    const agrDb = new Database(dbPath);
    try {
      agrDb.pragma('journal_mode = WAL');
      agrDb.pragma('wal_autocheckpoint = 0');
      agrDb.exec('CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
      agrDb.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB);');
      agrDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(0, 14, 3, stepBlob(14, 19), metaBlob(1782000000));
      agrDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
        .run(0, genBlob('gemini-4-neon', 12000));
      agrDb.pragma('wal_checkpoint(TRUNCATE)');

      let synced: { message_count: number; context_used_tokens: number | null } | undefined;
      for (let i = 0; i < 60; i++) {
        synced = getDb().prepare('SELECT message_count, context_used_tokens FROM browsing_sessions WHERE id = ?').get(id) as
          { message_count: number; context_used_tokens: number | null } | undefined;
        if (synced?.message_count === 1) break;
        await delay(100);
      }
      assert.equal(synced?.message_count, 1);
      assert.equal(synced?.context_used_tokens, 12000);
      assert.ok(updates.some(u => u.data.includes('"type":"session_parsed"') && u.data.includes(id)));

      agrDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(1, 15, 3, stepBlob(15, 20), metaBlob(1782000005));
      agrDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
        .run(1, genBlob('gemini-4-neon', 24000));

      let updated: { message_count: number; context_used_tokens: number | null } | undefined;
      for (let i = 0; i < 60; i++) {
        updated = getDb().prepare('SELECT message_count, context_used_tokens FROM browsing_sessions WHERE id = ?').get(id) as
          { message_count: number; context_used_tokens: number | null } | undefined;
        if (updated?.message_count === 2) break;
        await delay(100);
      }
      assert.equal(updated?.message_count, 2);
      assert.equal(updated?.context_used_tokens, 24000);
    } finally {
      agrDb.close();
      broadcaster.closeAllClients();
    }
  });

  test('startWatcher skips Antigravity cleanly when conversations directory is absent and attaches when it appears', async () => {
    const missingAgrDir = path.join(root, 'missing-antigravity');
    await stopWatcher();
    startWatcher({ claudeDir, codexHome, antigravityDir: missingAgrDir });

    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const lateConversations = path.join(missingAgrDir, 'conversations');
      fs.mkdirSync(lateConversations, { recursive: true });

      const statusRes = await fetch(`${baseUrl}/api/provider-quotas/antigravity/statusline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quota: {
            'gemini-5h': { remaining_fraction: 0.9, reset_time: '2026-11-26T02:00:00Z', reset_in_seconds: 3600 },
          },
        }),
      });
      assert.equal(statusRes.status, 202);

      const lateId = 'late-agr-watch-1';
      const lateDbPath = path.join(lateConversations, `${lateId}.db`);
      const agrDb = new Database(lateDbPath);
      try {
        agrDb.exec('CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
        agrDb.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB);');
        agrDb.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(0, 14, 3, stepBlob(14, 19), metaBlob(1782000000));
        agrDb.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
          .run(0, genBlob('gemini-4-neon', 15000));
      } finally {
        agrDb.close();
      }

      let synced: { message_count: number; context_used_tokens: number | null } | undefined;
      for (let i = 0; i < 40; i++) {
        synced = getDb().prepare('SELECT message_count, context_used_tokens FROM browsing_sessions WHERE id = ?').get(lateId) as
          { message_count: number; context_used_tokens: number | null } | undefined;
        if (synced?.message_count === 1) break;
        await delay(100);
      }
      assert.equal(synced?.message_count, 1);
      assert.equal(synced?.context_used_tokens, 15000);

      const agrDb2 = new Database(lateDbPath);
      try {
        agrDb2.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(1, 15, 3, stepBlob(15, 20), metaBlob(1782000005));
        agrDb2.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
          .run(1, genBlob('gemini-4-neon', 26000));
      } finally {
        agrDb2.close();
      }

      let updated: { message_count: number; context_used_tokens: number | null } | undefined;
      for (let i = 0; i < 40; i++) {
        updated = getDb().prepare('SELECT message_count, context_used_tokens FROM browsing_sessions WHERE id = ?').get(lateId) as
          { message_count: number; context_used_tokens: number | null } | undefined;
        if (updated?.message_count === 2) break;
        await delay(100);
      }
      assert.equal(updated?.message_count, 2);
      assert.equal(updated?.context_used_tokens, 26000);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      await stopWatcher();
    }
  });
});
