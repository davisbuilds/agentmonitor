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

const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

function seedUsage(agent: string, tokensIn: number, tokensOut: number, cacheRead: number, cacheWrite: number): void {
  getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cost_usd, created_at, source)
    VALUES (?, ?, 'llm_response', 'success', ?, ?, ?, ?, 0.01, ?, 'import')
  `).run(`e2e-tokens-${agent}`, agent, tokensIn, tokensOut, cacheRead, cacheWrite, now);
}

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-e2e-tokens-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();
  // Cache dominates, as it does in real use.
  seedUsage('codex', 1_000_000, 100_000, 20_000_000, 0);
  seedUsage('claude_code', 5_000, 900_000, 150_000_000, 4_000_000);

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

test('monitor headline counts every token, and its breakdown splits buckets and agents', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await expect(page.getByRole('heading', { name: 'Active Agents' })).toBeVisible();

  // 1.0M + 1.0M + 170.0M + 4.0M, cache included.
  await expect(page.getByTestId('monitor-total-tokens')).toHaveText('176.0M');

  await page.getByRole('button', { name: /show breakdown/ }).click();
  const panel = page.getByRole('dialog', { name: 'Token breakdown' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('recorded on this machine')).toBeVisible();

  const bucket = (label: string) => panel.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) });
  await expect(bucket('Input').locator('dd')).toHaveText('1.0M');
  await expect(bucket('Output').locator('dd')).toHaveText('1.0M');
  await expect(bucket('Cache read').locator('dd')).toHaveText('170.0M');
  await expect(bucket('Cache write').locator('dd')).toHaveText('4.0M');

  const agents = panel.getByTestId('monitor-agent-tokens');
  await expect(agents).toHaveCount(2);
  await expect(agents.nth(0)).toContainText('Claude Code');
  await expect(agents.nth(0)).toContainText('154.9M');
  await expect(agents.nth(1)).toContainText('Codex');
  await expect(agents.nth(1)).toContainText('21.1M');
});
