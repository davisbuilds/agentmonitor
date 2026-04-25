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
let getDb: typeof import('../src/db/connection.js').getDb;
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
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();
  const db = getDb();
  const insertSession = db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, message_count, user_message_count,
      live_status, integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSession.run(
    'e2e-route-session-a',
    'agentmonitor',
    'claude',
    'First seeded route session',
    '2026-03-24T12:00:00.000Z',
    0,
    0,
    'ended',
    'claude-jsonl',
    'full',
    JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' }),
  );
  insertSession.run(
    'e2e-route-session-b',
    'agentmonitor',
    'claude',
    'Second seeded route session',
    '2026-03-24T12:01:00.000Z',
    0,
    0,
    'ended',
    'claude-jsonl',
    'full',
    JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' }),
  );

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
  await expect(page.getByText('Analytics reflects session capability coverage.')).toBeVisible();
  await expect(page.getByText('This metric includes every session matching the current filters').first()).toBeVisible();
});

test('app restores search and session deep links from the hash', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#search?q=quota%20reset&sort=relevance`);
  await expect(page.getByPlaceholder('Search across transcript history...')).toHaveValue('quota reset');
  await expect(page.locator('select').first()).toHaveValue('relevance');

  await page.goto(`${baseUrl}/app/#sessions?session=missing-session&message=7`);
  await expect(page.getByRole('button', { name: /Back/ })).toBeVisible();
  await expect(page.getByText('Session not found: missing-session')).toBeVisible();
});

test('session viewer back restores the previously selected session', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?session=e2e-route-session-a`);
  await expect(page.getByText('First seeded route session')).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#sessions?session=e2e-route-session-b';
  });
  await expect(page.getByText('Second seeded route session')).toBeVisible();

  await page.getByRole('button', { name: /Back/ }).click();

  await expect(page.getByText('First seeded route session')).toBeVisible();
  await expect(page).toHaveURL(/#sessions\?session=e2e-route-session-a$/);
});

test('usage tab does not eagerly request v1 monitor filter options', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#usage`);

  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/usage/summary')).toBe(true);
  expect(requestedPaths).not.toContain('/api/filter-options');
});

test('monitor cost card uses v2 usage APIs instead of v1 cost stats', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#monitor`);

  await expect(page.getByText('Cost Overview')).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/usage/daily')).toBe(true);
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/usage/projects')).toBe(true);
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/usage/models')).toBe(true);
  expect(requestedPaths).not.toContain('/api/stats/cost');
});
