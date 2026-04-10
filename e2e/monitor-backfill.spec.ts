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

const sessionId = 'e2e-monitor-backfill-001';

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-e2e-monitor-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();

  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (
      id, agent_id, agent_type, project, branch, status, started_at, ended_at, last_event_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    'codex',
    'codex',
    'agentmonitor',
    'arch/codex-telemetry-convergence',
    'ended',
    '2026-04-10 11:30:00',
    '2026-04-10 11:45:00',
    '2026-04-10 11:45:00',
    '{}',
  );

  db.prepare(`
    INSERT INTO events (
      session_id, agent_type, event_type, tool_name, status, tokens_in, tokens_out, branch, project,
      created_at, metadata, cost_usd, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    'codex',
    'tool_use',
    'Write',
    'success',
    120,
    12,
    'arch/codex-telemetry-convergence',
    'agentmonitor',
    '2026-04-10 11:45:00',
    JSON.stringify({ file_path: '/Users/dg-mac-mini/Dev/agentmonitor/README.md', lines_added: 12 }),
    0.75,
    'api',
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

test('monitor backfills aggregate session metrics for newly reactivated sessions', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);

  await expect(page.getByRole('heading', { name: 'Active Agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: '30d' })).toBeVisible();
  await expect(page.getByRole('button', { name: '60d' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Codex 5h usage' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Codex 1w usage' })).toBeVisible();
  await expect(page.getByText('$0.00/$500.00')).toBeVisible();
  await expect(page.getByText('$0.75/$1500.00')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Frequency' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Write frequency' })).toBeVisible();
  await expect(
    page.locator('section').filter({ hasText: 'Cost Overview' }).getByText('1 session')
  ).toBeVisible();

  const response = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      agent_type: 'codex',
      event_type: 'response',
      status: 'success',
      tokens_in: 1,
      tokens_out: 3,
      cost_usd: 0.05,
      project: 'agentmonitor',
      branch: 'arch/codex-telemetry-convergence',
      metadata: { content_preview: 'Backfilled monitor session' },
    }),
  });

  expect(response.ok).toBeTruthy();

  const card = page.locator('button').filter({ hasText: 'agentmonitor' }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('2 events');
  await expect(card).toContainText('121 in');
  await expect(card).toContainText('15 out');
  await expect(card).toContainText('1 file');
  await expect(card).toContainText('+12');
  await expect(card).toContainText('$0.80');
  await expect(card).not.toContainText('-14400s ago');
});
