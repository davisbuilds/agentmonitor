import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe, mock } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';

// Isolate the DB before importing anything that reads config.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-reliability-pass-'));
const dbPath = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_DB_PATH = dbPath;
process.env.AGENTMONITOR_PROJECTS_DIR = tempDir;

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { createApp } = await import('../src/app.js');

let server: Server | undefined;
let baseUrl = '';
// A second connection to the same file: the other process (`amon import`
// beside the server's auto-import) in a cross-process race.
let rival: Database.Database | undefined;

function count(sql: string, ...params: unknown[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n;
}

function sessionState(id: string): { status: string; ended_at: string | null } | undefined {
  return getDb().prepare('SELECT status, ended_at FROM sessions WHERE id = ?').get(id) as
    { status: string; ended_at: string | null } | undefined;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200, url);
  return response.json() as Promise<T>;
}

interface MonitorSessionDetail {
  session: { event_count: number; tokens_in: number; tokens_out: number; status: string };
}

/** A Codex row the importer would mint from a transcript line long past. */
function historicalImport(sessionId: string, eventId: string) {
  return {
    event_id: eventId, session_id: sessionId, agent_type: 'codex', event_type: 'tool_use' as const,
    tool_name: 'shell', status: 'success' as const, tokens_in: 0, tokens_out: 0, metadata: {},
    source: 'import', client_timestamp: '2025-01-01T00:00:00.000Z',
  };
}

const PRECHECK_SQL = 'SELECT id FROM events WHERE event_id = ?';

/**
 * Run `body` so that a second connection commits `rivalWrite` immediately after
 * insertEvent's duplicate pre-check for `eventId` has seen nothing: the
 * interleaving two processes writing one WAL database can produce (the window
 * includes the `git` branch lookup). Returns whether the interleaving happened,
 * so a drifted seam fails loudly instead of passing vacuously.
 */
function withRivalCommitAfterPrecheck(eventId: string, rivalWrite: () => void, body: () => void): boolean {
  const db = getDb();
  const prepare = db.prepare.bind(db);
  let interleaved = false;
  mock.method(db, 'prepare', ((sql: string) => {
    const statement = prepare(sql);
    if (interleaved || sql !== PRECHECK_SQL) return statement;
    return {
      get: (...params: unknown[]) => {
        const row: unknown = Reflect.apply(statement.get, statement, params);
        if (params[0] === eventId) {
          interleaved = true;
          rivalWrite();
        }
        return row;
      },
    };
  }) as typeof db.prepare);
  try {
    body();
  } finally {
    mock.restoreAll();
  }
  return interleaved;
}

/** The rival stores `eventId` under `sessionId`, as insertEvent would. */
function rivalStores(eventId: string, sessionId: string): () => void {
  return () => {
    rival!.transaction(() => {
      rival!.prepare(`
        INSERT INTO sessions (id, agent_id, agent_type, status, ended_at)
        VALUES (?, 'codex-default', 'codex', 'ended', datetime('now'))
        ON CONFLICT(id) DO NOTHING
      `).run(sessionId);
      rival!.prepare(`
        INSERT INTO events (event_id, session_id, agent_type, event_type, status, source, client_timestamp)
        VALUES (?, ?, 'codex', 'tool_use', 'success', 'import', '2025-01-01T00:00:00.000Z')
      `).run(eventId, sessionId);
    })();
  };
}

before(async () => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(dbPath), 'the opened handle is the temp database');
  rival = new Database(dbPath, { timeout: 5_000 });
  server = createApp({ bindHost: '127.0.0.1' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('Failed to determine test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => (err ? reject(err) : resolve())));
  rival?.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a duplicate event_id is acknowledged and skipped without side effects', () => {
  test('a plain duplicate leaves its ended session as it was', () => {
    const sessionId = 'rp-dup-plain';
    assert.ok(insertEvent(historicalImport(sessionId, 'rp-dup-plain-1')));
    const stored = sessionState(sessionId);
    assert.equal(stored?.status, 'ended');

    assert.equal(insertEvent(historicalImport(sessionId, 'rp-dup-plain-1')), null);
    assert.deepEqual(sessionState(sessionId), stored);
  });

  test('a duplicate that loses the race to another writer leaves its ended session as it was', () => {
    // Two importers read the same historical transcript; the other commits the
    // row between this one's pre-check and its insert.
    const sessionId = 'rp-race-same';
    assert.ok(insertEvent(historicalImport(sessionId, 'rp-race-same-1')));
    const stored = sessionState(sessionId);
    assert.equal(stored?.status, 'ended');

    let result: unknown;
    const interleaved = withRivalCommitAfterPrecheck('rp-race-same-2', rivalStores('rp-race-same-2', sessionId), () => {
      result = insertEvent(historicalImport(sessionId, 'rp-race-same-2'));
    });
    assert.ok(interleaved, 'the rival committed between the pre-check and the insert');
    assert.equal(result, null, 'reported as a duplicate');
    assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE event_id = ?', 'rp-race-same-2'), 1);
    assert.deepEqual(sessionState(sessionId), stored, 'the losing duplicate did not reopen the session');
  });

  test('a duplicate that loses the race leaves no session without events', () => {
    // The id is already the rival's, under another session; the loser's own
    // session must not survive as an empty shell.
    let result: unknown;
    const interleaved = withRivalCommitAfterPrecheck('rp-race-shared', rivalStores('rp-race-shared', 'rp-race-owner'), () => {
      result = insertEvent({ ...historicalImport('rp-race-loser', 'rp-race-shared'), source: 'api', client_timestamp: undefined });
    });
    assert.ok(interleaved, 'the rival committed between the pre-check and the insert');
    assert.equal(result, null, 'reported as a duplicate');
    assert.equal(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', 'rp-race-loser'), 0, 'no orphan session');
    assert.equal(count(`
      SELECT COUNT(*) AS n FROM sessions s
      WHERE s.id LIKE 'rp-%' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)
    `), 0);
  });
});

describe('HTTP ingestion reads back once through the dashboard APIs', () => {
  test('a batch with an in-batch duplicate and a malformed item stores the rest once, and its retry stores nothing', async () => {
    const sessionId = 'rp-batch';
    const base = { session_id: sessionId, agent_type: 'claude_code' };
    const events = [
      { ...base, event_id: 'rp-batch-1', event_type: 'tool_use', tool_name: 'Bash', tokens_in: 10, tokens_out: 5 },
      // Same id, different payload: the first delivery wins.
      { ...base, event_id: 'rp-batch-1', event_type: 'tool_use', tool_name: 'Bash', tokens_in: 999, tokens_out: 999 },
      { ...base, event_id: 'rp-batch-2', event_type: 'tool_use', tokens_in: -1 },
      { ...base, event_id: 'rp-batch-3', event_type: 'llm_response', tokens_in: 20, tokens_out: 7 },
    ];

    const first = await postJson(`${baseUrl}/api/events/batch`, { events });
    assert.equal(first.status, 201);
    const firstBody = await first.json() as { received: number; duplicates: number; rejected: Array<{ index: number }> };
    assert.equal(firstBody.received, 2);
    assert.equal(firstBody.duplicates, 1);
    assert.deepEqual(firstBody.rejected.map(r => r.index), [2]);

    const retry = await postJson(`${baseUrl}/api/events/batch`, { events });
    const retryBody = await retry.json() as { received: number; duplicates: number };
    assert.equal(retryBody.received, 0);
    assert.equal(retryBody.duplicates, 3);

    const detail = await getJson<MonitorSessionDetail>(`${baseUrl}/api/v2/monitor/sessions/${sessionId}`);
    assert.equal(detail.session.event_count, 2);
    assert.equal(detail.session.tokens_in, 30);
    assert.equal(detail.session.tokens_out, 12);
    const listed = await getJson<{ total: number }>(`${baseUrl}/api/v2/monitor/events?session_id=${sessionId}`);
    assert.equal(listed.total, 2);
  });

  test('malformed payloads are refused without writing anything', async () => {
    const before = count('SELECT COUNT(*) AS n FROM events') + count('SELECT COUNT(*) AS n FROM sessions');
    const malformed = [
      '{"session_id": "rp-malformed", ',
      '[]',
      JSON.stringify({ session_id: 'rp-malformed', agent_type: 'claude_code', event_type: 'not_a_type' }),
      JSON.stringify({ session_id: 'rp-malformed', agent_type: 'claude_code', event_type: 'tool_use', client_timestamp: 'not a time' }),
      JSON.stringify({
        session_id: 'rp-malformed', agent_type: 'claude_code', event_type: 'llm_response',
        cache_write_tokens: 1, cache_write_1h_tokens: 2,
      }),
    ];
    for (const body of malformed) {
      const response = await fetch(`${baseUrl}/api/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(response.status, 400);
    }
    const afterCount = count('SELECT COUNT(*) AS n FROM events') + count('SELECT COUNT(*) AS n FROM sessions');
    assert.equal(afterCount, before);
  });

  test('a resent OTLP log batch is one event on the monitor session', async () => {
    const sessionId = 'rp-otel-retry';
    const payload = {
      resourceLogs: [{
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'codex_cli_rs' } },
          { key: 'conversation.id', value: { stringValue: sessionId } },
        ] },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '0',
            body: { stringValue: '{}' },
            attributes: [
              { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
              { key: 'event.kind', value: { stringValue: 'response.completed' } },
              { key: 'event.timestamp', value: { stringValue: '2026-09-23T12:00:00.000Z' } },
              { key: 'input_token_count', value: { intValue: 1000 } },
              { key: 'output_token_count', value: { intValue: 50 } },
            ],
          }],
        }],
      }],
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
      assert.equal(response.status, 200);
    }
    const detail = await getJson<MonitorSessionDetail>(`${baseUrl}/api/v2/monitor/sessions/${sessionId}`);
    assert.equal(detail.session.event_count, 1);
    assert.equal(detail.session.tokens_in, 1000);
    assert.equal(detail.session.tokens_out, 50);
  });

  test('concurrent deliveries of the same ids store each id once', async () => {
    const sessionId = 'rp-concurrent';
    const deliveries = Array.from({ length: 20 }, (_, index) => postJson(`${baseUrl}/api/events`, {
      event_id: `rp-concurrent-${index % 5}`, session_id: sessionId, agent_type: 'claude_code',
      event_type: 'tool_use', tool_name: 'Read', tokens_in: 1,
    }));
    const statuses = (await Promise.all(deliveries)).map(response => response.status).sort();
    assert.deepEqual([...new Set(statuses)], [200, 201]);
    assert.equal(statuses.filter(status => status === 201).length, 5);
    const detail = await getJson<MonitorSessionDetail>(`${baseUrl}/api/v2/monitor/sessions/${sessionId}`);
    assert.equal(detail.session.event_count, 5);
    assert.equal(detail.session.tokens_in, 5);
  });
});

describe('restart', () => {
  test('reopening and re-initializing keeps the schema version, the rows and the dedup', async () => {
    const version = getDb().pragma('user_version', { simple: true });
    const objects = count('SELECT COUNT(*) AS n FROM sqlite_master');
    const events = count('SELECT COUNT(*) AS n FROM events');
    const sessions = count('SELECT COUNT(*) AS n FROM sessions');

    closeDb();
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(dbPath));

    assert.equal(getDb().pragma('user_version', { simple: true }), version);
    assert.equal(count('SELECT COUNT(*) AS n FROM sqlite_master'), objects);
    assert.equal(count('SELECT COUNT(*) AS n FROM events'), events);
    assert.equal(count('SELECT COUNT(*) AS n FROM sessions'), sessions);
    assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok');
    assert.equal((getDb().pragma('foreign_key_check') as unknown[]).length, 0);

    // The same server keeps serving on the reopened handle, and an id stored
    // before the restart is still a duplicate after it.
    const resend = await postJson(`${baseUrl}/api/events`, {
      event_id: 'rp-batch-1', session_id: 'rp-batch', agent_type: 'claude_code', event_type: 'tool_use',
    });
    assert.equal(resend.status, 200);
    assert.deepEqual(await resend.json(), { received: 0, ids: [], duplicates: 1 });
    const detail = await getJson<MonitorSessionDetail>(`${baseUrl}/api/v2/monitor/sessions/rp-batch`);
    assert.equal(detail.session.event_count, 2);
  });
});
