import { test, expect, type Page } from '@playwright/test';
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
/* eslint-enable @typescript-eslint/consistent-type-imports */

const text = (value: string) => JSON.stringify([{ type: 'text', text: value }]);

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = await useIsolatedDb('agentmonitor-e2e-sessions-search-');
  const { initSchema } = await import('../src/db/schema.js');
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  const { createApp } = await import('../src/app.js');

  initSchema();
  const db = getDb();
  const full = JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' });
  const insertSession = db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, title, started_at, message_count, user_message_count,
      integration_mode, fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, 2, 1, 'claude-jsonl', 'full', ?)
  `);
  insertSession.run('sess-quota', 'agentmonitor', 'claude', 'Why does the quota reset at midnight?',
    'Quota investigation', '2026-10-01T10:00:00.000Z', full);
  insertSession.run('sess-importer', 'blueprint', 'codex', 'Rename the importer module',
    'Importer cleanup', '2026-10-01T11:00:00.000Z', full);

  const insertMessage = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, content_length)
    VALUES (?, ?, ?, ?, ?, 10)
  `);
  insertMessage.run('sess-quota', 0, 'user', text('Why does the quota reset at midnight?'), '2026-10-01T10:00:00.000Z');
  const quotaReply = insertMessage.run('sess-quota', 1, 'assistant', text('The window rolls over at a fixed hour.'), '2026-10-01T10:00:05.000Z');
  const importerAsk = insertMessage.run('sess-importer', 0, 'user', text('Rename the importer module'), '2026-10-01T11:00:00.000Z');
  insertMessage.run('sess-importer', 1, 'assistant', text('Renamed it and updated the callers.'), '2026-10-01T11:00:05.000Z');

  const insertPin = db.prepare('INSERT INTO pinned_messages (session_id, message_id, message_ordinal) VALUES (?, ?, ?)');
  insertPin.run('sess-quota', quotaReply.lastInsertRowid, 1);
  insertPin.run('sess-importer', importerAsk.lastInsertRowid, 0);

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

const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search transcripts' });
const pinnedToggle = (page: Page) => page.getByRole('button', { name: 'Pinned', exact: true });

test('Sessions searches transcripts in place of a Search tab; clearing the query returns to the list', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('button', { name: 'Sessions' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Search' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();

  await searchBox(page).fill('midnight');
  await expect(page).toHaveURL(/#sessions\?q=midnight$/);
  await expect(page.getByRole('button', { name: /msg #0.*Quota investigation/ })).toBeVisible();
  await expect(page.getByText('1 result', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toHaveCount(0);

  await searchBox(page).fill('');
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();
  await expect(page.getByText('2 total')).toBeVisible();
});

test('Back after starting a search returns to the session list', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();
  await searchBox(page).fill('midnight');
  await expect(page.getByRole('button', { name: /msg #0.*Quota investigation/ })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(searchBox(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();
});

test('a result opens its session at the message, and closing the viewer returns to the results', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?q=midnight&sort=relevance`);
  await expect(searchBox(page)).toHaveValue('midnight');
  await expect(page.getByLabel('Sort results')).toHaveValue('relevance');
  await page.getByRole('button', { name: /msg #0.*Quota investigation/ }).click();

  await expect(page).toHaveURL(/#sessions\?q=midnight&sort=relevance&session=sess-quota&message=0$/);
  await expect(page.getByRole('heading', { name: 'Quota investigation' })).toBeVisible();

  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page).toHaveURL(/#sessions\?q=midnight&sort=relevance$/);
  await expect(page.getByRole('button', { name: /msg #0.*Quota investigation/ })).toBeVisible();
});

test('a legacy Search link redirects into the Sessions search without trapping Back', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#search?q=midnight&sort=relevance`);
  await expect(page).toHaveURL(/#sessions\?q=midnight&sort=relevance$/);
  await expect(searchBox(page)).toHaveValue('midnight');
  await expect(page.getByRole('button', { name: /msg #0.*Quota investigation/ })).toBeVisible();

  // An in-app legacy link: the rewrite replaces the entry, so Back skips it.
  await page.goto(`${baseUrl}/app/#sessions`);
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#search?q=importer'; });
  await expect(page).toHaveURL(/#sessions\?q=importer$/);
  await expect(page.getByRole('button', { name: /msg #0.*Importer cleanup/ })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#sessions$/);
});

test('legacy Pinned links open the Pinned filter, which a query narrows', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?view=pinned`);
  await expect(page).toHaveURL(/#sessions\?pinned=1$/);
  await expect(pinnedToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('2 pinned')).toBeVisible();
  await expect(page.getByRole('button', { name: /The window rolls over/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rename the importer module/ })).toBeVisible();

  await page.goto(`${baseUrl}/app/#pinned`);
  await expect(page).toHaveURL(/#sessions\?pinned=1$/);
  await expect(page.getByText('2 pinned')).toBeVisible();

  await searchBox(page).fill('importer');
  await expect(page).toHaveURL(/#sessions\?q=importer&pinned=1$/);
  await expect(page.getByText('1 pinned')).toBeVisible();
  await expect(page.getByRole('button', { name: /The window rolls over/ })).toHaveCount(0);

  // Pinned off: the same query searches every transcript.
  await pinnedToggle(page).click();
  await expect(page).toHaveURL(/#sessions\?q=importer$/);
  await expect(pinnedToggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /msg #0.*Importer cleanup/ })).toBeVisible();

  // And on again, with the list behind it.
  await searchBox(page).fill('');
  await pinnedToggle(page).click();
  await expect(page).toHaveURL(/#sessions\?pinned=1$/);
  await expect(page.getByText('2 pinned')).toBeVisible();
});

test('a pin opens at its message, and Unpin removes it from the Pinned filter', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?pinned=1`);
  await page.getByRole('button', { name: /The window rolls over/ }).click();
  await expect(page).toHaveURL(/#sessions\?pinned=1&session=sess-quota&message=1$/);
  await expect(page.getByRole('heading', { name: 'Quota investigation' })).toBeVisible();
  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page).toHaveURL(/#sessions\?pinned=1$/);

  const quotaPin = getDb().prepare(
    "SELECT session_id, message_id, message_ordinal FROM pinned_messages WHERE session_id = 'sess-quota'",
  ).get() as { session_id: string; message_id: number; message_ordinal: number };
  try {
    await page.locator('div.items-start')
      .filter({ has: page.getByRole('button', { name: /The window rolls over/ }) })
      .getByRole('button', { name: 'Unpin' })
      .click();
    await expect(page.getByText('1 pinned')).toBeVisible();
    await expect(page.getByRole('button', { name: /The window rolls over/ })).toHaveCount(0);
  } finally {
    // Other tests in this worker share the database.
    getDb().prepare('INSERT OR IGNORE INTO pinned_messages (session_id, message_id, message_ordinal) VALUES (?, ?, ?)')
      .run(quotaPin.session_id, quotaPin.message_id, quotaPin.message_ordinal);
  }
});

test('the Project filter narrows the list and the search results at once', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();

  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('blueprint');
  await expect(page).toHaveURL(/#sessions\?project=blueprint$/);
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Quota investigation/ })).toHaveCount(0);

  // Both transcripts mention "the"; the filter keeps only blueprint's.
  await searchBox(page).fill('the');
  await expect(page.getByRole('button', { name: /msg #\d.*Importer cleanup/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Quota investigation/ })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('agentmonitor');
  await expect(page).toHaveURL(/project=agentmonitor/);
  await expect(page.getByRole('button', { name: /msg #\d.*Quota investigation/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Importer cleanup/ })).toHaveCount(0);
});

test('Pin shows on hover or focus, while Pinned always shows', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?session=sess-quota`);
  const ask = page.locator('[data-message-ordinal="0"]');
  const reply = page.locator('[data-message-ordinal="1"]');
  const pin = ask.getByRole('button', { name: 'Pin', exact: true });
  const opacity = (locator: typeof pin) => locator.evaluate(el => getComputedStyle(el).opacity);

  await expect(pin).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect.poll(() => opacity(pin)).toBe('0');
  await expect.poll(() => opacity(reply.getByRole('button', { name: 'Pinned', exact: true }))).toBe('1');

  await ask.hover();
  await expect.poll(() => opacity(pin)).toBe('1');

  // Reachable from the keyboard too.
  await page.mouse.move(0, 0);
  await pin.focus();
  await expect.poll(() => opacity(pin)).toBe('1');
});

test('a result snippet shows what the message says, and a stored JSON key matches nothing', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions?q=midnight`);
  const result = page.getByRole('button', { name: /msg #0.*Quota investigation/ });
  await expect(result).toContainText('Why does the quota reset at midnight?');
  await expect(result).not.toContainText('"type"');

  await searchBox(page).fill('text');
  await expect(page.getByText('0 results', { exact: true })).toBeVisible();
});

test('the session list is a table, and any cell of a row opens its session', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  const headers = page.getByRole('columnheader');
  await expect(headers).toHaveText(['Session', 'Project', 'Messages', 'Started']);
  const row = page.getByRole('row').filter({ hasText: 'Importer cleanup' });
  await expect(row).toContainText('Codex');
  await row.getByText('blueprint', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Importer cleanup' })).toBeVisible();
});

test('the top tabs put Analytics second', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);
  await expect(page.getByRole('navigation').getByRole('button')).toHaveText(['Monitor', 'Analytics', 'Sessions', 'Benchmarks']);
});

const paletteInput = (page: Page) => page.getByPlaceholder('Jump to a session or transcript match…');
const paletteTrigger = (page: Page) => page.getByRole('button', { name: 'Jump to session or transcript', exact: true });

async function openPalette(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/app/#`);
  await paletteTrigger(page).click();
  await expect(paletteInput(page)).toBeFocused();
  await expect(page.getByRole('button', { name: /Quota investigation/ })).toBeVisible();
}

test('palette close button responds to Enter without opening a session', async ({ page }) => {
  await openPalette(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Esc', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(paletteInput(page)).toHaveCount(0);
  await expect(page).toHaveURL(`${baseUrl}/app/#`);
  await expect(paletteTrigger(page)).toBeFocused();
});

test('palette contains forward and backward tab focus', async ({ page }) => {
  await openPalette(page);
  const lastResult = page.getByRole('button', { name: /Quota investigation/ });
  await page.keyboard.press('Shift+Tab');
  await expect(lastResult).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(paletteInput(page)).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Jump to session or transcript' })).toBeVisible();

  await paletteInput(page).fill('unmatchedword');
  await expect(page.getByText('No transcript matches found.')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Relevance', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(paletteInput(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(paletteInput(page)).toBeFocused();
  await expect(page).toHaveURL(`${baseUrl}/app/#`);
});

test('palette dismissals restore focus and allow reopening', async ({ page }) => {
  await openPalette(page);
  for (const key of ['Escape', 'ControlOrMeta+k']) {
    await page.keyboard.press(key);
    await expect(paletteInput(page)).toHaveCount(0);
    await expect(paletteTrigger(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(paletteInput(page)).toBeFocused();
  }
  await page.mouse.click(5, 5);
  await expect(paletteInput(page)).toHaveCount(0);
  await expect(paletteTrigger(page)).toBeFocused();
  await expect(page).toHaveURL(`${baseUrl}/app/#`);
});

test('Enter opens the focused result rather than the highlighted result', async ({ page }) => {
  await openPalette(page);
  await page.keyboard.press('Tab'); // Close button.
  await page.keyboard.press('Tab'); // Newest result (Importer cleanup).
  await page.keyboard.press('Tab'); // Older result, without moving the pointer.
  await expect(page.getByRole('button', { name: /Quota investigation/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#sessions\?session=sess-quota$/);
  await expect(page.getByRole('heading', { name: 'Quota investigation' })).toBeVisible();
});

test('input arrow navigation still opens the selected session', async ({ page }) => {
  await openPalette(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#sessions\?session=sess-quota$/);
  await expect(page.getByRole('heading', { name: 'Quota investigation' })).toBeVisible();
});

test('Enter on palette sort controls changes search order without navigating', async ({ page }) => {
  await openPalette(page);
  await paletteInput(page).fill('quota');
  await expect(page.getByText('Showing 1 of 1 transcript matches')).toBeVisible();
  await page.keyboard.press('Tab'); // Close button.
  await page.keyboard.press('Tab'); // Recent sort.
  await page.keyboard.press('Tab'); // Relevance sort.
  await expect(page.getByRole('button', { name: 'Relevance', exact: true })).toBeFocused();
  const sorted = page.waitForResponse(response => response.url().includes('/api/v2/search?') && response.url().includes('sort=relevance'));
  await page.keyboard.press('Enter');
  expect((await sorted).ok()).toBe(true);
  await expect(paletteInput(page)).toBeVisible();
  await expect(page).toHaveURL(`${baseUrl}/app/#`);
});


test('shortcut dismissal restores the invoking control on another tab', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#`);
  const sessionsTab = page.getByRole('button', { name: 'Sessions', exact: true });
  await sessionsTab.click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(paletteInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(paletteInput(page)).toHaveCount(0);
  await expect(sessionsTab).toBeFocused();
  await expect(page).toHaveURL(`${baseUrl}/app/#sessions`);
});
