import { test, expect, type Page } from '@playwright/test';
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
let setInsightProviderConfigForTests: typeof import('../src/insights/service.js').setInsightProviderConfigForTests;
/* eslint-enable @typescript-eslint/consistent-type-imports */

const NO_KEYS = {
  openai: { apiKey: null },
  anthropic: { apiKey: null },
  gemini: { apiKey: null },
} as const;

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = await useIsolatedDb('agentmonitor-e2e-analytics-views-');

  const { initSchema } = await import('../src/db/schema.js');
  ({ closeDb } = await import('../src/db/connection.js'));
  ({ setInsightProviderConfigForTests } = await import('../src/insights/service.js'));
  const { createApp } = await import('../src/app.js');

  initSchema();
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve Playwright test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  setInsightProviderConfigForTests?.(null);
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function subTab(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

// The server runs in this process, so the override (not the developer's
// ambient API keys) decides whether a provider is configured.
test('Insights is hidden and its deep link falls back to Overview without an API key', async ({ page }) => {
  setInsightProviderConfigForTests(NO_KEYS);

  const status = page.waitForResponse(res => new URL(res.url()).pathname === '/api/v2/insights');
  await page.goto(`${baseUrl}/app/#analytics`);
  // Control: the sub-view bar has rendered and the key status has answered,
  // so a missing Insights tab is not just a page that hasn't finished loading.
  await expect(subTab(page, 'Quality')).toBeVisible();
  await status;
  await expect(subTab(page, 'Insights')).toHaveCount(0);

  const fresh = await page.context().newPage();
  await fresh.goto(`${baseUrl}/app/#analytics?view=insights&kind=usage`);
  await expect(fresh).not.toHaveURL(/view=insights/);
  await expect(subTab(fresh, 'Overview')).toHaveAttribute('aria-pressed', 'true');
  await expect(fresh.getByRole('heading', { name: 'Tool Usage' })).toBeVisible();
  await expect(fresh.getByRole('button', { name: 'Generate Insight' })).toHaveCount(0);
});

test('Insights appears once any provider has an API key', async ({ page }) => {
  setInsightProviderConfigForTests({ ...NO_KEYS, gemini: { apiKey: 'test-gemini-key' } });

  await page.goto(`${baseUrl}/app/#analytics`);
  await expect(subTab(page, 'Insights')).toBeVisible();

  const fresh = await page.context().newPage();
  await fresh.goto(`${baseUrl}/app/#analytics?view=insights`);
  await expect(fresh).toHaveURL(/view=insights/);
  await expect(subTab(fresh, 'Insights')).toHaveAttribute('aria-pressed', 'true');
  await expect(fresh.getByRole('button', { name: 'Generate Insight' })).toBeVisible();
});
