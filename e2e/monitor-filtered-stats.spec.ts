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
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let getStats: typeof import('../src/db/queries.js').getStats;
let broadcaster: typeof import('../src/sse/emitter.js').broadcaster;
/* eslint-enable @typescript-eslint/consistent-type-imports */

const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

function seedUsage(agent: string, cost: number, tokensIn: number): void {
  getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, created_at, source)
    VALUES (?, ?, 'llm_response', 'success', ?, 0, ?, ?, 'import')
  `).run(`e2e-filtered-${agent}`, agent, tokensIn, cost, now);
}

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }
  tempDir = await useIsolatedDb('agentmonitor-e2e-filtered-stats-');

  const { initSchema } = await import('../src/db/schema.js');
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ getStats } = await import('../src/db/queries.js'));
  ({ broadcaster } = await import('../src/sse/emitter.js'));
  const { createApp } = await import('../src/app.js');

  initSchema();
  seedUsage('codex', 3, 300);
  seedUsage('claude_code', 97, 9_700);

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

test('an agent filter keeps its totals when the unfiltered stats broadcast arrives', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  const tokens = page.getByTestId('monitor-total-tokens');
  const costToday = page.getByTestId('monitor-cost-today');
  await expect(tokens).toHaveText('10.0K');
  await expect(costToday).toHaveText('$100.00');

  await page.getByRole('combobox').first().selectOption('codex');
  await expect(tokens).toHaveText('300');
  await expect(costToday).toHaveText('$3.00');

  // The server's periodic snapshot is always unfiltered.
  for (let i = 0; i < 3; i++) {
    broadcaster.broadcast('stats', getStats() as unknown as Record<string, unknown>);
    await page.waitForTimeout(300);
  }
  await expect(tokens).toHaveText('300');
  await expect(costToday).toHaveText('$3.00');

  // Clearing the filter takes the unfiltered snapshot again.
  await page.getByRole('combobox').first().selectOption('');
  await expect(tokens).toHaveText('10.0K');
  await expect(costToday).toHaveText('$100.00');
});
