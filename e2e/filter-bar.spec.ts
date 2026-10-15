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
/* eslint-enable @typescript-eslint/consistent-type-imports */

// Long enough that a select sized to its longest option overflows one row.
const LONG_PROJECT = 'a-project-name-long-enough-to-stretch-a-native-select-across-the-bar';
const LONG_TOOL = 'mcp__plugin_some_server__a_tool_name_long_enough_to_stretch_its_select';

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }
  tempDir = await useIsolatedDb('agentmonitor-e2e-filter-bar-');

  const { initSchema } = await import('../src/db/schema.js');
  ({ closeDb } = await import('../src/db/connection.js'));
  const { getDb } = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');

  initSchema();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const insertEvent = getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, tool_name, status, model, project, tokens_in, tokens_out, cost_usd, created_at, source)
    VALUES (?, ?, ?, ?, 'success', ?, ?, 100, 10, ?, ?, 'import')
  `);
  insertEvent.run('e2e-bar-claude', 'claude_code', 'tool_use', LONG_TOOL, null, LONG_PROJECT, 0, now);
  insertEvent.run('e2e-bar-claude', 'claude_code', 'llm_response', null, 'claude-opus-4-8', LONG_PROJECT, 2, now);
  insertEvent.run('e2e-bar-codex', 'codex', 'llm_response', null, 'gpt-5.6', 'beta', 1, now);

  const insertMonitorSession = getDb().prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata)
    VALUES (?, ?, ?, ?, 'main', 'active', ?, ?, '{}')
  `);
  insertMonitorSession.run('e2e-bar-claude', 'claude_code', 'claude_code', LONG_PROJECT, now, now);
  insertMonitorSession.run('e2e-bar-codex', 'codex', 'codex', 'beta', now, now);

  const insertSession = getDb().prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, message_count, user_message_count,
      live_status, integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, 4, 2, 'ended', 'claude-jsonl', 'full', ?)
  `);
  const capabilities = JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' });
  insertSession.run('e2e-bar-session-1', LONG_PROJECT, 'claude', 'Seeded long-project session', new Date().toISOString(), capabilities);
  insertSession.run('e2e-bar-session-2', 'beta', 'codex', 'Seeded beta session', new Date().toISOString(), capabilities);

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

const MAX_SELECT_WIDTH = 192;
// One row of 32px controls plus the bar's padding; a wrapped bar is ~90px.
const MAX_BAR_HEIGHT = 56;

async function expectOneRowBar(page: Page, hash: string): Promise<void> {
  await page.goto(`${baseUrl}/app/#${hash}`);
  const bar = page.getByTestId('filter-bar');
  await expect(bar).toBeVisible();
  // Wait for the option lists to load; an empty select is trivially narrow.
  await expect(bar.getByRole('combobox', { name: 'Filter by agent' }).locator('option')).not.toHaveCount(1);
  const selects = bar.getByRole('combobox');
  for (const select of await selects.all()) {
    const box = await select.boundingBox();
    expect(box?.width ?? 0, `${await select.getAttribute('aria-label')} on #${hash}`).toBeLessThanOrEqual(MAX_SELECT_WIDTH);
  }
  const box = await bar.boundingBox();
  expect(box?.height ?? Infinity, `bar height on #${hash}`).toBeLessThanOrEqual(MAX_BAR_HEIGHT);
}

test('every tab lays its filters out in one bar of capped controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const hash of [
    'monitor',
    'sessions',
    'analytics',
    'analytics?view=usage',
    'analytics?view=quality',
    // With filters set, Clear and the Filters count join the row.
    `analytics?view=usage&from=2026-09-01&to=2026-09-30&project=${LONG_PROJECT}&agent=codex&provider=anthropic`,
    `sessions?q=seeded&project=${LONG_PROJECT}&agent=claude&pinned=1`,
  ]) {
    await expectOneRowBar(page, hash);
  }
});

test('Monitor filters by agent only, and the filter reaches the cards', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  const bar = page.getByTestId('filter-bar');
  await expect(bar.getByRole('combobox')).toHaveCount(1);
  await expect(bar.getByRole('button', { name: 'More filters' })).toHaveCount(0);

  await expect(page.getByText('2 sessions', { exact: true })).toBeVisible();
  await bar.getByRole('combobox', { name: 'Filter by agent' }).selectOption('codex');
  await expect(page.getByText('1 session', { exact: true })).toBeVisible();
});

test('Usage facets sit behind the bar\'s Filters button', async ({ page }) => {
  const usageRequests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v2/usage/')) usageRequests.push(url);
  });
  await page.goto(`${baseUrl}/app/#analytics?view=usage`);
  await expect(page.getByText('Usage facets')).toHaveCount(0);
  const bar = page.getByTestId('filter-bar');
  await bar.getByRole('button', { name: 'More filters' }).click();
  await page.getByRole('combobox', { name: 'Filter by provider' }).selectOption('anthropic');
  await expect.poll(() => usageRequests.some(url => url.searchParams.get('provider') === 'anthropic')).toBe(true);
  await expect(bar.getByRole('button', { name: 'More filters' })).toContainText('1');
});

test('a Usage deep link reads only Usage', async ({ page }) => {
  const analyticsReads: string[] = [];
  const usageReads: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/v2/analytics/')) analyticsReads.push(pathname);
    if (pathname.startsWith('/api/v2/usage/')) usageReads.push(pathname);
  });
  await page.goto(`${baseUrl}/app/#analytics?view=usage`);
  await expect.poll(() => usageReads.length).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  expect(analyticsReads).toEqual([]);
});

test('the quick range in force is marked, and Usage\'s total cost names its window', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=usage&from=2026-09-01&to=2026-09-30`);
  const bar = page.getByTestId('filter-bar');
  for (const label of ['7D', '30D', '90D']) {
    await expect(bar.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(page.getByTestId('usage-total-cost')).toContainText('Sep 1 – Sep 30');
  const range = bar.getByRole('button', { name: /^Date range/ });
  await expect(range).toHaveText('Sep 1 – Sep 30');

  // A custom range is set in the range button's popover.
  await range.click();
  await page.getByLabel('From date').fill('2026-09-10');
  await expect(page).toHaveURL(/from=2026-09-10/);
  await expect(range).toHaveText('Sep 10 – Sep 30');
  await page.keyboard.press('Escape');

  await bar.getByRole('button', { name: '7D', exact: true }).click();
  await expect(bar.getByRole('button', { name: '7D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: '30D', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('Clear resets everything in the bar', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  const bar = page.getByTestId('filter-bar');
  await expect(bar.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await bar.getByRole('combobox', { name: 'Filter by project' }).selectOption('beta');
  await bar.getByRole('button', { name: 'Pinned' }).click();
  await bar.getByRole('button', { name: 'Clear' }).click();
  await expect(bar.getByRole('combobox', { name: 'Filter by project' })).toHaveValue('');
  await expect(bar.getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page).not.toHaveURL(/project=|pinned=/);
  await expect(bar.getByRole('button', { name: 'Clear' })).toHaveCount(0);

  // On Usage, the facets behind Filters are part of the bar too.
  await page.goto(`${baseUrl}/app/#analytics?view=usage&provider=anthropic`);
  await expect(bar.getByRole('button', { name: 'More filters' })).toContainText('1');
  await bar.getByRole('button', { name: 'Clear' }).click();
  await expect(bar.getByRole('button', { name: 'More filters' })).not.toContainText('1');
  await expect(page).not.toHaveURL(/provider=/);
});
