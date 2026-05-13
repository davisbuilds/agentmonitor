import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType } from '../src/db/connection.js';

let server: Server;
let baseUrl = '';
let tempDir = '';
let dbPath = '';
let closeDb: typeof closeDbType;
const originalConsoleError = console.error;

function removeDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-router-errors-'));
  dbPath = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');
  closeDb = dbModule.closeDb;
  console.error = () => undefined;

  initSchema();
  closeDb();
  removeDbFiles();

  server = createApp({ serveStatic: false }).listen(0);
  await once(server, 'listening');
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  closeDb();
  console.error = originalConsoleError;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('v2 router returns scoped 500 errors when the backing database is unavailable', async () => {
  const cases: Array<[string, string]> = [
    ['/api/v2/sessions', 'Failed to list sessions'],
    ['/api/v2/sessions/missing', 'Failed to get session'],
    ['/api/v2/sessions/missing/messages', 'Failed to get messages'],
    ['/api/v2/sessions/missing/activity', 'Failed to get session activity'],
    ['/api/v2/sessions/missing/pins', 'Failed to list session pins'],
    ['/api/v2/sessions/missing/messages/1/pin', 'Failed to pin message'],
    ['/api/v2/sessions/missing/messages/1/pin', 'Failed to unpin message'],
    ['/api/v2/sessions/missing/children', 'Failed to get children'],
    ['/api/v2/pins', 'Failed to list pins'],
    ['/api/v2/live/sessions', 'Failed to list live sessions'],
    ['/api/v2/live/sessions/missing', 'Failed to get live session'],
    ['/api/v2/live/sessions/missing/turns', 'Failed to get live turns'],
    ['/api/v2/live/sessions/missing/items', 'Failed to get live items'],
    ['/api/v2/analytics/summary', 'Failed to get analytics summary'],
    ['/api/v2/analytics/activity', 'Failed to get activity data'],
    ['/api/v2/analytics/projects', 'Failed to get project data'],
    ['/api/v2/analytics/tools', 'Failed to get tool data'],
    ['/api/v2/monitor/tools', 'Failed to get monitor tool data'],
    ['/api/v2/monitor/sessions', 'Failed to list monitor sessions'],
    ['/api/v2/monitor/events', 'Failed to list monitor events'],
    ['/api/v2/monitor/stats', 'Failed to get monitor stats'],
    ['/api/v2/monitor/filter-options', 'Failed to get monitor filter options'],
    ['/api/v2/monitor/sessions/missing/transcript', 'Failed to get monitor session transcript'],
    ['/api/v2/monitor/sessions/missing', 'Failed to get monitor session detail'],
    ['/api/v2/analytics/skills/daily', 'Failed to get skill analytics'],
    ['/api/v2/analytics/hour-of-week', 'Failed to get hour-of-week analytics'],
    ['/api/v2/analytics/top-sessions', 'Failed to get top sessions analytics'],
    ['/api/v2/analytics/velocity', 'Failed to get velocity analytics'],
    ['/api/v2/analytics/agents', 'Failed to get agent analytics'],
    ['/api/v2/usage/summary', 'Failed to get usage summary'],
    ['/api/v2/usage/daily', 'Failed to get daily usage'],
    ['/api/v2/usage/projects', 'Failed to get usage by project'],
    ['/api/v2/usage/models', 'Failed to get usage by model'],
    ['/api/v2/usage/agents', 'Failed to get usage by agent'],
    ['/api/v2/usage/top-sessions', 'Failed to get top usage sessions'],
    ['/api/v2/insights', 'Failed to list insights'],
    ['/api/v2/insights/1', 'Failed to get insight'],
    ['/api/v2/insights/1', 'Failed to delete insight'],
    ['/api/v2/projects', 'Failed to get projects'],
    ['/api/v2/agents', 'Failed to get agents'],
  ];

  for (const [route, error] of cases) {
    const method = route.includes('/messages/1/pin') && error.includes('unpin')
      || route === '/api/v2/insights/1' && error.includes('delete')
      ? 'DELETE'
      : route.includes('/messages/1/pin')
        ? 'POST'
        : 'GET';
    const res = await fetch(`${baseUrl}${route}`, { method });
    assert.equal(res.status, 500, `${method} ${route}`);
    const body = await res.json() as { error: string };
    assert.equal(body.error, error);
  }

  const searchRes = await fetch(`${baseUrl}/api/v2/search?q=hello`);
  assert.equal(searchRes.status, 400);
  const searchBody = await searchRes.json() as { error: string };
  assert.equal(searchBody.error, 'Invalid search query syntax');

  const generateRes = await fetch(`${baseUrl}/api/v2/insights/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'overview',
      date_from: '2026-03-01',
      date_to: '2026-03-01',
    }),
  });
  assert.equal(generateRes.status, 500);
  const generateBody = await generateRes.json() as { error: string };
  assert.match(generateBody.error, /no such table/i);
});
