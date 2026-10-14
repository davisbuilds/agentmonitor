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

const PARENT_UUID = '01a135ab-28ea-70f2-a603-35d75f361637';
const PARENT_ROLLOUT = `rollout-2026-10-01T10-00-00-${PARENT_UUID}`;
const CHILD_ROLLOUT = 'rollout-2026-10-01T10-05-00-01a13839-347a-79a2-b7b0-2359f2547f8a';

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = await useIsolatedDb('agentmonitor-e2e-session-titles-');
  const { initSchema } = await import('../src/db/schema.js');
  const { getDb } = await import('../src/db/connection.js');
  ({ closeDb } = await import('../src/db/connection.js'));
  const { createApp } = await import('../src/app.js');

  initSchema();
  const insert = getDb().prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, title, started_at, message_count, user_message_count,
      parent_session_id, relationship_type, integration_mode, fidelity, capabilities_json
    ) VALUES (?, 'agentmonitor', ?, ?, ?, ?, 2, 1, ?, ?, ?, 'full', ?)
  `);
  const full = JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' });
  insert.run('claude-parent', 'claude', 'Audit the parser for silent failures', 'Parser audit',
    '2026-10-01T10:01:00.000Z', null, null, 'claude-jsonl', full);
  insert.run('agent-hunt-1', 'claude', 'You are hunter one', 'hunt the cache layer',
    '2026-10-01T10:02:00.000Z', 'claude-parent', 'subagent', 'claude-jsonl', full);
  insert.run('agent-hunt-2', 'claude', 'You are hunter two', 'hunt the importer',
    '2026-10-01T10:03:00.000Z', 'claude-parent', 'subagent', 'claude-jsonl', full);
  insert.run(PARENT_ROLLOUT, 'codex', 'Review the open pull request', null,
    '2026-10-01T10:04:00.000Z', null, 'conversation', 'codex-jsonl', full);
  insert.run(CHILD_ROLLOUT, 'codex', null, 'emil pstack',
    '2026-10-01T10:05:00.000Z', PARENT_UUID, 'subagent', 'codex-jsonl', full);
  insert.run('codex-title-job', 'codex', 'Generate a concise, single-line task title', null,
    '2026-10-01T10:06:00.000Z', null, 'internal', 'codex-otel', full);

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

test('the session list names sessions and nests subagents under their parent', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  await expect(page.getByRole('button', { name: /Parser audit/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Review the open pull request/ })).toBeVisible();
  await expect(page.getByText('2 total')).toBeVisible();
  await expect(page.getByText('hunt the cache layer')).toHaveCount(0);
  await expect(page.getByText('Generate a concise')).toHaveCount(0);

  const toggle = page.getByRole('button', { name: '2 subagents' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /hunt the cache layer/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /hunt the importer/ })).toBeVisible();

  await page.getByRole('button', { name: '1 subagent' }).click();
  await expect(page.getByRole('button', { name: /emil pstack/ })).toBeVisible();
});

test("a parent's subagent opens from the viewer, and Back returns to the parent", async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?session=claude-parent`);
  await expect(page.getByRole('heading', { name: 'Parser audit' })).toBeVisible();

  await page.getByRole('button', { name: 'hunt the cache layer' }).click();
  await expect(page.getByRole('heading', { name: 'hunt the cache layer' })).toBeVisible();

  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page.getByRole('heading', { name: 'Parser audit' })).toBeVisible();
});
