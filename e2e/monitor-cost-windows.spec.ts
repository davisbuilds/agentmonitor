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
let initSchema: typeof import('../src/db/schema.js').initSchema;
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let createApp: typeof import('../src/app.js').createApp;
/* eslint-enable @typescript-eslint/consistent-type-imports */

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function seedCost(sessionId: string, cost: number, createdAt: string): void {
  getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, created_at, source)
    VALUES (?, 'claude_code', 'llm_response', 'success', 100, 10, ?, ?, 'import')
  `).run(sessionId, cost, createdAt);
}

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = await useIsolatedDb('agentmonitor-e2e-cost-windows-');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();
  seedCost('e2e-cost-today', 1.25, new Date().toISOString());
  seedCost('e2e-cost-recent', 2, daysAgo(10));
  // Outside both windows: only an all-time total would count it.
  seedCost('e2e-cost-old', 4, daysAgo(45));

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

test('the Monitor names its cost windows, and its 30 days matches Usage', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);

  await expect(page.getByTestId('monitor-cost-today')).toHaveText('$1.25');
  await expect(page.getByTestId('monitor-cost-30d')).toHaveText('$3.25');
  await expect(page.getByText('$7.25')).toHaveCount(0);

  await page.goto(`${baseUrl}/app/#analytics?view=usage`);
  const usageTotal = page.getByText('Total Cost', { exact: true }).locator('xpath=..');
  await expect(usageTotal).toContainText('$3.25');
});
