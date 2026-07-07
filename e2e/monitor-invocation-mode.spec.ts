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

// Seed one active headless and one active interactive session so we can assert
// the Monitor renders the "headless" pill on the former and not the latter.
function seedSession(project: string, mode: 'headless' | 'interactive'): void {
  const db = getDb();
  const id = `e2e-mode-${mode}`;
  db.prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'claude_code', 'claude_code', project, 'main', 'active', now, now, JSON.stringify({ mode }));
  db.prepare(`
    INSERT INTO events (session_id, agent_type, event_type, tool_name, status, tokens_in, tokens_out, project, created_at, metadata, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'claude_code', 'tool_use', 'Read', 'success', 10, 2, project, now, '{}', 'api');
}

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-e2e-mode-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();
  seedSession('proj-headless', 'headless');
  seedSession('proj-interactive', 'interactive');

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

test('monitor shows a headless pill only on headless sessions', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await expect(page.getByRole('heading', { name: 'Active Agents' })).toBeVisible();

  const headlessCard = page.locator('button').filter({ hasText: 'proj-headless' }).first();
  const interactiveCard = page.locator('button').filter({ hasText: 'proj-interactive' }).first();

  await expect(headlessCard).toBeVisible();
  await expect(interactiveCard).toBeVisible();

  await expect(headlessCard.getByText('headless', { exact: true })).toBeVisible();
  await expect(interactiveCard.getByText('headless', { exact: true })).toHaveCount(0);
});
