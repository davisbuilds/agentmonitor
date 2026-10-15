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
  tempDir = await useIsolatedDb('agentmonitor-e2e-usage-daily-');

  const { initSchema } = await import('../src/db/schema.js');
  ({ closeDb } = await import('../src/db/connection.js'));
  const { getDb } = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');

  initSchema();
  const insert = getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, status, model, project, tokens_in, tokens_out, cost_usd, created_at, source)
    VALUES (?, ?, 'llm_response', 'success', ?, 'alpha', ?, ?, ?, ?, 'import')
  `);
  insert.run('daily-a', 'claude_code', 'claude-haiku-4-5-20251001', 1000, 200, 3, '2026-09-10 12:00:00');
  insert.run('daily-b', 'codex', 'openai/gpt-6-astra', 500, 100, 1, '2026-09-10 13:00:00');
  insert.run('daily-a', 'claude_code', 'claude-haiku-4-5-20251001', 2000, 400, 5, '2026-09-11 12:00:00');
  // An unpriced model: tokens but no cost.
  insert.run('daily-c', 'codex', 'mystery-model-1', 1000, 200, 0, '2026-09-20 12:00:00');

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

test('Daily usage is one chart: each day says its totals and narrows the page when clicked', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=usage&from=2026-09-10&to=2026-09-11`);
  await expect(page.getByRole('heading', { name: 'Daily Usage by Model' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily Usage', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Top Models' })).toHaveCount(0);

  // The legend spells models the one way the app does.
  const chart = page.getByRole('region', { name: 'Daily Usage by Model' });
  await expect(chart.getByText('claude-haiku-4-5', { exact: true })).toBeVisible();
  await expect(chart.getByText('gpt-6-astra', { exact: true })).toBeVisible();

  const day = chart.getByRole('button', { name: /^2026-09-10:/ });
  await expect(day).toHaveAccessibleName('2026-09-10: $4.00 · 1.8K tokens · 2 usage events · 2 sessions');

  await day.click();
  await expect(page).toHaveURL(/from=2026-09-10&to=2026-09-10/);
});

test('days with usage but no cost still show, with a pointer to the token view', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=usage&from=2026-09-20&to=2026-09-20`);
  const chart = page.getByRole('region', { name: 'Daily Usage by Model' });
  await expect(chart.getByRole('button', { name: /^2026-09-20:/ }))
    .toHaveAccessibleName('2026-09-20: $0.00 · 1.2K tokens · 1 usage event · 1 session');
  await expect(chart.getByText('No model usage for this range.')).toHaveCount(0);
  await expect(chart.getByText(/No cost recorded/)).toBeVisible();

  await chart.getByRole('button', { name: 'All tokens' }).click();
  await expect(chart.getByText(/No cost recorded/)).toHaveCount(0);
  await expect(chart.getByText('mystery-model-1', { exact: true })).toBeVisible();
});
