import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { Server } from 'node:http';

let tempDir = '';
let baseUrl = '';
let server: Server;
/* eslint-disable @typescript-eslint/consistent-type-imports */
let initSchema: typeof import('../src/db/schema.js').initSchema;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let liveBroadcaster: typeof import('../src/api/v2/live-stream.js').liveBroadcaster;
let createApp: typeof import('../src/app.js').createApp;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-live-stream-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ closeDb } = await import('../src/db/connection.js'));
  ({ liveBroadcaster } = await import('../src/api/v2/live-stream.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();
  liveBroadcaster.resetForTests();

  const app = createApp({ serveStatic: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve test server address');
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  liveBroadcaster.resetForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function readSseEvents(url: string, expectedCount: number): Promise<Array<{ id: string; data: string }>> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id: string; data: string }> = [];
  let buffer = '';

  try {
    while (events.length < expectedCount) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const lines = chunk.split('\n');
        const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim() ?? '';
        const data = lines.find(line => line.startsWith('data:'))?.slice(5).trim() ?? '';
        if (data) events.push({ id, data });
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }

  return events;
}

test('live stream replays buffered events after the provided since id', async () => {
  liveBroadcaster.resetForTests();
  liveBroadcaster.broadcast('session_presence', {
    session_id: 'replay-session',
    live_status: 'live',
  });
  liveBroadcaster.broadcast('item_delta', {
    session_id: 'replay-session',
    inserted_items: 1,
  });

  const events = await readSseEvents(`${baseUrl}/api/v2/live/stream?since=1`, 2);
  assert.equal(events.length, 2);

  const replayed = JSON.parse(events[0].data) as { id: number; type: string; payload?: Record<string, unknown> };
  const connected = JSON.parse(events[1].data) as { type: string; payload?: Record<string, unknown> };

  assert.equal(replayed.type, 'item_delta');
  assert.equal(replayed.payload?.session_id, 'replay-session');
  assert.equal(connected.type, 'connected');
  assert.equal(connected.payload?.replayed, 1);
});

test('live stream replay respects session filters', async () => {
  liveBroadcaster.resetForTests();
  liveBroadcaster.broadcast('item_delta', {
    session_id: 'session-a',
    inserted_items: 1,
  });
  liveBroadcaster.broadcast('item_delta', {
    session_id: 'session-b',
    inserted_items: 1,
  });

  const events = await readSseEvents(`${baseUrl}/api/v2/live/stream?since=0&session_id=session-b`, 2);
  const replayed = JSON.parse(events[0].data) as { type: string; payload?: Record<string, unknown> };
  const connected = JSON.parse(events[1].data) as { type: string; payload?: Record<string, unknown> };

  assert.equal(replayed.type, 'item_delta');
  assert.equal(replayed.payload?.session_id, 'session-b');
  assert.equal(connected.payload?.replayed, 1);
});
