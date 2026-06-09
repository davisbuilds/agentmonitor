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

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-e2e-trace-quality-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));

  initSchema();
  const db = getDb();
  // Two days back so the UTC timestamp stays inside the explorer's local-date filter
  // window regardless of the runner's timezone.
  const now = new Date(Date.now() - 2 * 86_400_000).toISOString();

  db.prepare(`
    INSERT INTO trace_quality_traces (id, session_id, agent_type, name, status, started_at, coverage_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'e2e-trace-1', 'e2e-sess-1', 'codex', 'Seeded explorer trace', 'success', now,
    JSON.stringify({ has_full_transcript: true, has_tool_details: true, has_token_usage: true, has_cost: true, projection_confidence: 'high' }),
  );

  const insertObs = db.prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, parent_observation_id, session_id, source_kind, observation_type, name,
      status, model, tool_name, started_at, duration_ms, tokens_in, tokens_out, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertObs.run('e2e-obs-root', 'e2e-trace-1', null, 'e2e-sess-1', 'event', 'generation', 'Root generation', 'success', 'gpt-5', null, now, 4200, 1200, 300, 0.05);
  insertObs.run('e2e-obs-child', 'e2e-trace-1', 'e2e-obs-root', 'e2e-sess-1', 'event', 'tool', 'Bash call', 'success', null, 'Bash', now, 800, 0, 0, null);

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

test('quality explorer lists a trace, opens its tree, and edits a local score', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=quality`);

  // Trace list renders the seeded trace with coverage badges.
  const traceRow = page.getByRole('button', { name: /Seeded explorer trace/ });
  await expect(traceRow).toBeVisible();
  await expect(page.getByText('Full transcript').first()).toBeVisible();

  // Open the trace -> observation tree appears with both observations.
  await traceRow.click();
  await expect(page.getByRole('heading', { name: 'Seeded explorer trace' })).toBeVisible();
  await expect(page.getByText('Root generation')).toBeVisible();
  await expect(page.getByText('Bash call')).toBeVisible();
  await expect(page).toHaveURL(/trace=e2e-trace-1$/);

  // Add a local pass/fail score on the trace.
  await page.getByPlaceholder('Score name (e.g. correctness)').fill('correctness');
  await page.getByRole('button', { name: 'Add score', exact: true }).click();

  const scoreRow = page.locator('li', { hasText: 'correctness' });
  await expect(scoreRow).toBeVisible();
  await expect(scoreRow.getByText('pass')).toBeVisible();

  // Remove it again.
  await scoreRow.getByRole('button', { name: /Delete score correctness/ }).click();
  await expect(page.locator('li', { hasText: 'correctness' })).toHaveCount(0);
});

test('quality explorer restores an open trace from the hash deep link', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=quality&trace=e2e-trace-1`);
  await expect(page.getByRole('heading', { name: 'Seeded explorer trace' })).toBeVisible();
  await expect(page.getByText('Root generation')).toBeVisible();
});
