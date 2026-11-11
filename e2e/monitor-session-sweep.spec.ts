import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { useIsolatedDb } from './isolated-db.js';

let tempDir = '';
let baseUrl = '';
let server: Server;
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let updateIdleSessions: typeof import('../src/db/queries.js').updateIdleSessions;
let stopSessionSweepBroadcast: typeof import('../src/api/stream.js').stopSessionSweepBroadcast;
/* eslint-enable @typescript-eslint/consistent-type-imports */

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }
  tempDir = await useIsolatedDb('agentmonitor-e2e-sweep-');

  const { initSchema } = await import('../src/db/schema.js');
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ updateIdleSessions } = await import('../src/db/queries.js'));
  const stream = await import('../src/api/stream.js');
  stopSessionSweepBroadcast = stream.stopSessionSweepBroadcast;
  const { createApp } = await import('../src/app.js');

  initSchema();
  // What the runtime starts beside its periodic sweep.
  stream.startSessionSweepBroadcast();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [session_id, project] of [['e2e-sweep-stays', 'sweep-stays'], ['e2e-sweep-ends', 'sweep-ends']]) {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, agent_type: 'codex', event_type: 'tool_use', tool_name: 'Read', project }),
    });
    if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  }
});

test.afterAll(async () => {
  stopSessionSweepBroadcast();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a session the sweep ends leaves Active Agents without a reload', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  const cards = page.locator('button', { hasText: /sweep-(stays|ends)/ });
  await expect(cards).toHaveCount(2);

  // Wait for the page's SSE stream before the sweep, which is broadcast once.
  await expect.poll(async () => {
    const health = await (await fetch(`${baseUrl}/api/health`)).json() as { sse_clients: number };
    return health.sse_clients;
  }).toBeGreaterThan(0);

  // Quiet past two timeouts, then the periodic sweep runs.
  getDb().prepare("UPDATE sessions SET last_event_at = datetime('now', '-30 minutes') WHERE id = 'e2e-sweep-ends'").run();
  const sweep = updateIdleSessions(5);
  expect(sweep.transitions).toEqual([{ session_id: 'e2e-sweep-ends', status: 'ended' }]);

  await expect(page.locator('button', { hasText: 'sweep-ends' })).toHaveCount(0);
  await expect(page.locator('button', { hasText: 'sweep-stays' })).toHaveCount(1);
  await expect(page.getByText('1 session', { exact: true })).toBeVisible();
});
