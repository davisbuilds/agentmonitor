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
let liveBroadcaster: typeof import('../src/api/v2/live-stream.js').liveBroadcaster;
/* eslint-enable @typescript-eslint/consistent-type-imports */

const sessionId = 'e2e-live-001';

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-e2e-live-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_ENABLE_LIVE_TAB = 'true';

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ liveBroadcaster } = await import('../src/api/v2/live-stream.js'));

  initSchema();
  liveBroadcaster.resetForTests();

  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, live_status, last_item_at, integration_mode, fidelity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    'agentmonitor',
    'claude',
    'Inspect the repo',
    '2026-03-24T12:00:00.000Z',
    '2026-03-24T12:00:05.000Z',
    2,
    1,
    'live',
    '2026-03-24T12:00:05.000Z',
    'claude-jsonl',
    'full',
  );

  const turn = db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    'claude',
    'claude-message:1',
    'completed',
    'Inspect the repo',
    '2026-03-24T12:00:00.000Z',
    '2026-03-24T12:00:05.000Z',
  );

  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    Number(turn.lastInsertRowid),
    0,
    'e2e-item-001',
    'assistant_message',
    'success',
    JSON.stringify({ text: 'Initial live response from seeded session' }),
    '2026-03-24T12:00:05.000Z',
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
  liveBroadcaster.resetForTests();
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('live tab renders seeded sessions and reacts to streamed item deltas', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#live`);

  await expect(page.getByRole('heading', { name: 'Live' })).toBeVisible();
  await expect(page.getByText('Prompts on')).toBeVisible();
  await expect(page.getByText('Codex: otel-only')).toBeVisible();

  const sessionButton = page.locator('button').filter({ hasText: 'Inspect the repo' }).first();
  await expect(sessionButton).toBeVisible();
  await sessionButton.click();

  await expect(page.locator('p', { hasText: 'Initial live response from seeded session' }).first()).toBeVisible();

  const db = getDb();
  const turn = db.prepare('SELECT id FROM session_turns WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as { id: number };
  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turn.id,
    1,
    'e2e-item-002',
    'assistant_message',
    'success',
    JSON.stringify({ text: 'Streamed follow-up from test' }),
    '2026-03-24T12:00:06.000Z',
  );
  db.prepare('UPDATE browsing_sessions SET last_item_at = ?, live_status = ? WHERE id = ?').run(
    '2026-03-24T12:00:06.000Z',
    'live',
    sessionId,
  );
  liveBroadcaster.broadcast('item_delta', {
    session_id: sessionId,
    inserted_items: 1,
    last_item_at: '2026-03-24T12:00:06.000Z',
  });

  await expect(page.locator('p', { hasText: 'Streamed follow-up from test' }).first()).toBeVisible();
});
