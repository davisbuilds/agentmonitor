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
let liveBroadcaster: typeof import('../src/api/v2/live-stream.js').liveBroadcaster;
/* eslint-enable @typescript-eslint/consistent-type-imports */

const sessionId = 'e2e-live-001';
const summarySessionId = 'e2e-live-002';
// On the Monitor, but with no live record behind it.
const noLiveSessionId = 'e2e-live-003';

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = await useIsolatedDb('agentmonitor-e2e-live-');
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
      user_message_count, live_status, last_item_at, integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    JSON.stringify({
      history: 'full',
      search: 'full',
      tool_analytics: 'full',
      live_items: 'full',
    }),
  );

  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, live_status, last_item_at, integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summarySessionId,
    'agentmonitor',
    'codex',
    'Review OTEL stream',
    '2026-03-24T12:01:00.000Z',
    null,
    0,
    0,
    'live',
    '2026-03-24T12:01:03.000Z',
    'codex-otel',
    'summary',
    JSON.stringify({
      history: 'none',
      search: 'none',
      tool_analytics: 'none',
      live_items: 'summary',
    }),
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

  const summaryTurn = db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    summarySessionId,
    'codex',
    'codex-turn:1',
    'running',
    'Review OTEL stream',
    '2026-03-24T12:01:00.000Z',
    null,
  );

  db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summarySessionId,
    Number(summaryTurn.lastInsertRowid),
    0,
    'e2e-item-summary-001',
    'message',
    'running',
    JSON.stringify({ text: 'Codex live summary item from OTEL stream' }),
    '2026-03-24T12:01:03.000Z',
  );

  // The Monitor's agent cards are the v1 sessions; each card opens its live stream.
  const now = new Date().toISOString();
  const insertCard = db.prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '{}')
  `);
  insertCard.run(sessionId, 'claude_code', 'claude_code', 'card-full-stream', 'main', now, now);
  insertCard.run(summarySessionId, 'codex', 'codex', 'card-summary-stream', 'main', now, now);
  insertCard.run(noLiveSessionId, 'claude_code', 'claude_code', 'card-no-stream', 'main', now, now);
  // One event gives the Monitor's filter bar an Agent option to show.
  db.prepare(`
    INSERT INTO events (session_id, agent_type, event_type, tool_name, status, project, created_at, metadata, source)
    VALUES (?, 'claude_code', 'tool_use', 'Read', 'success', 'card-full-stream', ?, '{}', 'api')
  `).run(sessionId, now);

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

function card(page: import('@playwright/test').Page, project: string) {
  return page.locator('button', { hasText: project });
}

test('an agent card opens its live stream inside Monitor, which follows new items', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);

  const nav = page.locator('header nav');
  await expect(nav.getByRole('button', { name: 'Monitor' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Live' })).toHaveCount(0);

  await expect(page.getByRole('combobox', { name: 'Agent' })).toBeVisible();
  await card(page, 'card-full-stream').click();
  await expect(page).toHaveURL(new RegExp(`#monitor\\?session=${sessionId}$`));
  await expect(page.getByRole('heading', { name: 'Inspect the repo' })).toBeVisible();
  await expect(page.locator('p', { hasText: 'Initial live response from seeded session' }).first()).toBeVisible();
  // The Monitor's filters apply to the cards, not to a single session.
  await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Capture/ }).click();
  const capture = page.getByRole('dialog', { name: 'Capture settings' });
  await expect(capture.getByText('Prompts')).toBeVisible();
  await expect(capture.getByText('otel-only')).toBeVisible();
  await page.keyboard.press('Escape');

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
    'e2e-item-003',
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

  await page.getByRole('button', { name: '← Active agents' }).click();
  await expect(page).toHaveURL(new RegExp('/app/#?$'));
  await expect(card(page, 'card-summary-stream')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Agent' })).toBeVisible();
});

test('an old #live link lands on the Monitor', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#live`);
  await expect(card(page, 'card-full-stream')).toBeVisible();
  await expect(page).toHaveURL(new RegExp('/app/#?$'));
});

test('a card with no live record says so and offers its recent events', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await card(page, 'card-no-stream').click();

  await expect(page.getByText('No live stream for this session.')).toBeVisible();
  await page.getByRole('button', { name: 'Show recent events' }).click();
  await expect(page.getByRole('heading', { name: 'Session Details' })).toBeVisible();
});

test('a tool call and its result read as one row without routine success badges', async ({ page }) => {
  const db = getDb();
  const turn = db.prepare('SELECT id FROM session_turns WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as { id: number };
  const insert = db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(sessionId, turn.id, 2, 'toolu_e2e_status', 'tool_call', 'success',
    JSON.stringify({ tool_name: 'Bash', input: { command: 'git status --short' } }), '2026-03-24T12:00:07.000Z');
  insert.run(sessionId, turn.id, 3, 'toolu_e2e_status', 'tool_result', 'success',
    JSON.stringify({ content: 'nothing to commit, working tree clean', is_error: false }), '2026-03-24T12:00:08.000Z');

  await page.goto(`${baseUrl}/app/#monitor?session=${sessionId}`);

  const row = page.locator('button', { hasText: 'git status --short' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Bash');
  await expect(row).toContainText('nothing to commit, working tree clean');
  // The result has no row of its own, and success is left unsaid.
  await expect(page.locator('button', { hasText: 'nothing to commit, working tree clean' })).toHaveCount(1);
  const stream = page.locator('section', { has: page.getByRole('heading', { name: 'Inspect the repo' }) });
  await expect(stream.getByText('success', { exact: true })).toHaveCount(0);

  await row.click();
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
});

test('summary-only Codex sessions explain missing transcript history', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await card(page, 'card-summary-stream').click();
  await expect(page.getByRole('heading', { name: 'Review OTEL stream' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Live activity only' }).first()).toBeVisible();

  await expect(page.locator('p', { hasText: 'Codex live summary item from OTEL stream' }).first()).toBeVisible();
  await expect(page.getByText('No transcript was recorded for this session')).toBeVisible();

  await page.getByRole('button', { name: 'Open in Sessions' }).click();

  await expect(page.getByText('No transcript for this session.')).toBeVisible();
  await expect(page.getByText('Its source (Codex telemetry) records activity but not the conversation')).toBeVisible();
  await page.getByRole('button', { name: 'Live activity only' }).click();
  const detail = page.getByRole('dialog', { name: 'Session detail' });
  await expect(detail.getByRole('listitem').filter({ hasText: 'Transcript' })).toContainText('Not available');
  await expect(detail.getByRole('listitem').filter({ hasText: 'Live stream' })).toContainText('Summary');
});

test('with the live view turned off, a card opens the recent-events drawer instead', async ({ page }) => {
  await page.route('**/api/v2/live/settings', route => route.fulfill({
    json: {
      enabled: false,
      codex_mode: 'otel-only',
      capture: { prompts: true, reasoning: true, tool_arguments: true },
      diff_payload_max_bytes: 32768,
    },
  }));

  // A followed-session link has nothing to follow, so it shows the cards,
  // with their filters.
  await page.goto(`${baseUrl}/app/#monitor?session=${sessionId}`);
  await expect(card(page, 'card-full-stream')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inspect the repo' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Agent' })).toBeVisible();

  await card(page, 'card-summary-stream').click();
  await expect(page.getByRole('heading', { name: 'Session Details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review OTEL stream' })).toHaveCount(0);
});

test('a session whose record fails to load offers a retry instead of loading forever', async ({ page }) => {
  let failing = true;
  await page.route(`**/api/v2/live/sessions/${sessionId}`, route => (
    failing ? route.fulfill({ status: 500, json: { error: 'boom' } }) : route.continue()
  ));

  await page.goto(`${baseUrl}/app/#monitor?session=${sessionId}`);
  await expect(page.getByText("Couldn't load this session.")).toBeVisible();
  await expect(page.getByText('Loading session…')).toHaveCount(0);

  failing = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Inspect the repo' })).toBeVisible();
});
