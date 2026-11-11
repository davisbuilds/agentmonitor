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
/* eslint-enable @typescript-eslint/consistent-type-imports */

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }
  tempDir = await useIsolatedDb('agentmonitor-e2e-quota-stale-');
  const { initSchema } = await import('../src/db/schema.js');
  ({ closeDb } = await import('../src/db/connection.js'));
  const { upsertProviderQuotaSnapshot } = await import('../src/db/queries.js');
  const { createApp } = await import('../src/app.js');
  initSchema();

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  upsertProviderQuotaSnapshot({
    provider: 'codex',
    status: 'available',
    source: 'codex-app-server',
    updated_at: minutesAgo(20),
    plan_type: 'pro',
    primary: { used_percent: 40, resets_at: null, window_minutes: 300 },
    secondary: { used_percent: 10, resets_at: null, window_minutes: 10080 },
  });
  upsertProviderQuotaSnapshot({
    provider: 'codex',
    status: 'error',
    source: 'codex-app-server',
    updated_at: minutesAgo(1),
    error_message: 'Timed out waiting for Codex quota response after 5000ms',
  });

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a failed quota refresh keeps the last good reading, marked stale', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  const pill = page.getByRole('button', { name: 'Quota left: Codex 60% (stale)' });
  await expect(pill).toBeVisible();

  await pill.click();
  const detail = page.getByRole('dialog', { name: 'Provider quota detail' });
  await expect(detail.getByText(/Stale: read 20 ?m(in)? ago/)).toBeVisible();
  await expect(detail.getByText('Refresh failed: Timed out waiting for Codex quota response after 5000ms', { exact: false })).toBeVisible();
  await expect(detail.getByText('60% left')).toBeVisible();
  await expect(detail.getByText(/last tried/)).toBeVisible();
  if (process.env.QUOTA_STALE_SCREENSHOT) await page.screenshot({ path: process.env.QUOTA_STALE_SCREENSHOT });
});
