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
  const { getDb } = await import('../src/db/connection.js');
  getDb().prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, message_count, user_message_count,
      live_status, integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'e2e-analytics-views-session',
    'alpha',
    'claude',
    'Seeded analytics session',
    new Date().toISOString(),
    4,
    2,
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

test('Overview leaves top sessions to Usage and skill panels to Skills', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });

  await page.goto(`${baseUrl}/app/#analytics`);
  // Control: Overview rendered and fetched its own panels.
  await expect(page.getByRole('heading', { name: 'Tool Usage' })).toBeVisible();
  await expect.poll(() => requestedPaths.includes('/api/v2/analytics/summary')).toBe(true);
  await expect(page.getByRole('heading', { name: 'Top Sessions' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Raw skill invocation volume' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Skill consultations' })).toHaveCount(0);
  expect(requestedPaths).not.toContain('/api/v2/analytics/top-sessions');
  expect(requestedPaths).not.toContain('/api/v2/analytics/skills/daily');

  // The one Top Sessions panel is Usage's, ranked by cost.
  await subTab(page, 'Usage').click();
  await expect(page.getByRole('heading', { name: 'Top Sessions' })).toHaveCount(1);

  await subTab(page, 'Skills').click();
  await expect(page.getByRole('heading', { name: 'Raw skill invocation volume' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Skill consultation explorer' })).toBeVisible();
  // Skills keeps the skill sections the Overview export used to carry.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^agentmonitor-skills-.*\.csv$/);
});

test('the shared project filter scopes the skill volume chart on Skills', async ({ page }) => {
  const skillRequests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v2/analytics/skills/daily') skillRequests.push(url);
  });

  await page.goto(`${baseUrl}/app/#analytics?view=skills`);
  await expect(page.getByRole('heading', { name: 'Raw skill invocation volume' })).toBeVisible();
  await expect.poll(() => skillRequests.length).toBeGreaterThan(0);

  await page.getByLabel('Filter by project').selectOption('alpha');
  await expect.poll(() => skillRequests.some(url => url.searchParams.get('project') === 'alpha')).toBe(true);
  await expect(page).toHaveURL(/view=skills/);
});
