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
let closeDb: typeof import('../src/db/connection.js').closeDb;
let getStats: typeof import('../src/db/queries.js').getStats;
let broadcaster: typeof import('../src/sse/emitter.js').broadcaster;
/* eslint-enable @typescript-eslint/consistent-type-imports */

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }
  tempDir = await useIsolatedDb('agentmonitor-e2e-stale-build-');

  const { initSchema } = await import('../src/db/schema.js');
  ({ closeDb } = await import('../src/db/connection.js'));
  ({ getStats } = await import('../src/db/queries.js'));
  ({ broadcaster } = await import('../src/sse/emitter.js'));
  const { createApp } = await import('../src/app.js');
  initSchema();

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve Playwright test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const push = (stale: boolean) => broadcaster.broadcast('stats', {
  ...getStats(), server_build: { tracked: true, stale },
} as unknown as Record<string, unknown>);

test('the header asks for a restart while the server runs an older build', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await expect(page.getByRole('heading', { name: 'Active Agents' })).toBeVisible();
  const notice = page.getByTestId('stale-build-notice');
  await expect(notice).toHaveCount(0);

  await expect(async () => { push(true); await expect(notice).toBeVisible({ timeout: 500 }); }).toPass();
  await notice.click();
  await expect(page.getByRole('dialog', { name: 'Server restart needed' })).toContainText('older build');

  push(false);
  await expect(notice).toHaveCount(0);
});
