import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

let tempDir = '';
let baseUrl = '';
let server: Server;
/* eslint-disable @typescript-eslint/consistent-type-imports */
let initSchema: typeof import('../src/db/schema.js').initSchema;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let createApp: typeof import('../src/app.js').createApp;
/* eslint-enable @typescript-eslint/consistent-type-imports */

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-e2e-search-analytics-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

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
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('search and analytics tabs explain capability boundaries', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#search`);
  await expect(page.getByText('Search is capability-aware.')).toBeVisible();
  await expect(page.getByText('Only sessions with searchable history appear here.')).toBeVisible();

  await page.goto(`${baseUrl}/app/#analytics`);
  await expect(page.getByText('Analytics mixes session-level and history-level coverage.')).toBeVisible();
  await expect(page.getByText('Tool usage still depends on tool-analytics-capable sessions')).toBeVisible();
});
