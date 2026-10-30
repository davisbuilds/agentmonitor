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
let getDb: typeof import('../src/db/connection.js').getDb;
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
  ({ getDb } = await import('../src/db/connection.js'));
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

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

// Saved under a key that has since been removed; inside the default 30-day window.
function saveInsight(title: string): number | bigint {
  return getDb().prepare(`
    INSERT INTO insights (
      kind, title, prompt, content, date_from, date_to, project, agent, provider, model,
      analytics_summary_json, analytics_coverage_json, usage_summary_json, usage_coverage_json, input_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'overview',
    title,
    null,
    'Saved insight body.',
    daysAgo(7),
    daysAgo(3),
    null,
    null,
    'openai',
    'gpt-5-mini',
    JSON.stringify({ total_sessions: 1, total_messages: 4 }),
    JSON.stringify({ included_sessions: 1, matching_sessions: 1, note: '' }),
    JSON.stringify({ total_usage_events: 0, total_cost_usd: 0 }),
    JSON.stringify({ usage_events: 0, matching_events: 0, note: '' }),
    JSON.stringify({ analytics_activity: [] }),
  ).lastInsertRowid;
}

test('saved insights stay readable without an API key, with generation disabled', async ({ page }) => {
  setInsightProviderConfigForTests(NO_KEYS);
  const title = 'Insight saved under an earlier key';
  const id = saveInsight(title);

  try {
    const generateRequests: string[] = [];
    page.context().on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v2/insights/generate') generateRequests.push(request.method());
    });

    await page.goto(`${baseUrl}/app/#analytics`);
    await expect(subTab(page, 'Insights')).toBeVisible();

    const fresh = await page.context().newPage();
    await fresh.goto(`${baseUrl}/app/#analytics?view=insights`);
    await expect(subTab(fresh, 'Insights')).toHaveAttribute('aria-pressed', 'true');
    await expect(fresh.getByText(title).first()).toBeVisible();
    await expect(fresh.getByRole('button', { name: 'Generate Insight' })).toBeDisabled();

    // A kind with nothing saved empties the slice; the view must stay put.
    const listLoaded = fresh.waitForResponse(res => {
      const url = new URL(res.url());
      return url.pathname === '/api/v2/insights' && url.searchParams.get('kind') === 'workflow';
    });
    await fresh.locator('select:has(option[value="workflow"])').selectOption('workflow');
    await listLoaded;
    await expect(fresh.getByText('No saved insights for the current filters.')).toBeVisible();
    await expect(fresh).toHaveURL(/view=insights/);
    await expect(subTab(fresh, 'Insights')).toHaveAttribute('aria-pressed', 'true');
    await expect(fresh.getByRole('button', { name: 'Generate Insight' })).toBeDisabled();
    expect(generateRequests).toEqual([]);
  } finally {
    getDb().prepare('DELETE FROM insights WHERE id = ?').run(id);
  }
});

test('deleting the final saved insight without an API key drops Insights', async ({ page }) => {
  setInsightProviderConfigForTests(NO_KEYS);
  const title = 'Final saved insight, deleted here';
  const id = saveInsight(title);

  try {
    await page.goto(`${baseUrl}/app/#analytics?view=insights`);
    await expect(page.getByText(title).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate Insight' })).toBeDisabled();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).not.toHaveURL(/view=insights/);
    await expect(subTab(page, 'Overview')).toHaveAttribute('aria-pressed', 'true');
    await expect(subTab(page, 'Insights')).toHaveCount(0);
  } finally {
    getDb().prepare('DELETE FROM insights WHERE id = ?').run(id);
  }
});

test('a refresh after the final saved insight is removed elsewhere drops Insights', async ({ page }) => {
  setInsightProviderConfigForTests(NO_KEYS);
  const title = 'Final saved insight, removed elsewhere';
  const id = saveInsight(title);

  try {
    await page.goto(`${baseUrl}/app/#analytics?view=insights`);
    await expect(page.getByText(title).first()).toBeVisible();

    // Removed outside this page (another tab, the CLI).
    getDb().prepare('DELETE FROM insights WHERE id = ?').run(id);
    await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
    await expect(page).not.toHaveURL(/view=insights/);
    await expect(subTab(page, 'Overview')).toHaveAttribute('aria-pressed', 'true');
    await expect(subTab(page, 'Insights')).toHaveCount(0);
  } finally {
    getDb().prepare('DELETE FROM insights WHERE id = ?').run(id);
  }
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

test('Overview opens on the headline row, with Velocity folded into it', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics`);
  const headlines = page.getByRole('region', { name: 'Overview headlines' });
  await expect(headlines).toBeVisible();
  for (const tile of ['cost', 'prompts', 'sessions', 'tool-errors', 'active-hours']) {
    await expect(headlines.getByTestId(`headline-${tile}`)).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Velocity' })).toHaveCount(0);
  await expect(page.getByText('Active filters')).toHaveCount(0);
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
