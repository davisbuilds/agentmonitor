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
  tempDir = await useIsolatedDb('agentmonitor-e2e-unpriced-models-');

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

const push = (unpriced_models: Array<{ model: string; usage_events: number; last_seen: string }>) => broadcaster.broadcast('stats', {
  ...getStats(), unpriced_models,
} as unknown as Record<string, unknown>);

test('the header names models whose usage bills as $0', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await expect(page.getByRole('heading', { name: 'Active Agents' })).toBeVisible();
  const notice = page.getByTestId('unpriced-models-notice');
  await expect(notice).toHaveCount(0);

  const models = [
    { model: 'gpt-new', usage_events: 12, last_seen: '2026-10-04 12:00:00' },
    { model: 'claude-new', usage_events: 1, last_seen: '2026-10-03 12:00:00' },
  ];
  await expect(async () => { push(models); await expect(notice).toBeVisible({ timeout: 500 }); }).toPass();
  await expect(notice).toHaveText('2 unpriced models');
  await notice.click();
  const dialog = page.getByRole('dialog', { name: 'Unpriced models' });
  await expect(dialog).toContainText('gpt-new');
  await expect(dialog).toContainText('12 events');
  await expect(dialog).toContainText('claude-new');

  push([]);
  await expect(notice).toHaveCount(0);
});
