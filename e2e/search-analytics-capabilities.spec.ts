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
  const activeMonitorTimestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (
      id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'e2e-monitor-model-session',
    'codex',
    'codex',
    'agentmonitor',
    'main',
    'active',
    activeMonitorTimestamp,
    activeMonitorTimestamp,
    '{}',
  );
  db.prepare(`
    INSERT INTO events (
      session_id, agent_type, event_type, status, tokens_in, tokens_out, project, branch,
      model, created_at, metadata, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'e2e-monitor-model-session',
    'codex',
    'llm_response',
    'success',
    1200,
    240,
    'agentmonitor',
    'main',
    'gpt-5.5',
    activeMonitorTimestamp,
    JSON.stringify({ reasoning_effort: 'high' }),
    'otel',
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

test('monitor filters use the v2 monitor endpoint instead of v1 filter options', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#monitor`);

  await expect(page.getByRole('combobox').first()).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/monitor/filter-options')).toBe(true);
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

test('monitor stats bar uses the v2 monitor endpoint instead of v1 stats', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#monitor`);

  await expect(page.getByText('Events:')).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/monitor/stats')).toBe(true);
  expect(requestedPaths).not.toContain('/api/stats');
});

test('monitor tool analytics use the v2 monitor endpoint instead of v1 tool stats', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#monitor`);

  await expect(page.getByText('Tool Analytics')).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/monitor/tools')).toBe(true);
  expect(requestedPaths).not.toContain('/api/stats/tools');
});

test('monitor active sessions use the v2 monitor endpoint instead of v1 sessions', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#monitor`);

  await expect(page.getByText('Active Agents')).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/monitor/sessions')).toBe(true);
  expect(requestedPaths).not.toContain('/api/sessions');
});

test('monitor event feed uses the v2 monitor endpoint instead of v1 events', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#monitor`);

  await expect(page.getByRole('heading', { name: 'All Events' })).toBeVisible();
  await expect.poll(() => requestedPaths.some(pathname => pathname === '/api/v2/monitor/events')).toBe(true);
  expect(requestedPaths).not.toContain('/api/events');
});

test('monitor active agent cards include model and reasoning effort when available', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#monitor`);

  const card = page.locator('button').filter({ hasText: 'agentmonitor' }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('codex (gpt-5.5 high)');
});
