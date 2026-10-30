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
const longSessionId = 'e2e-live-long';
// A stream with an open tool call partway down, for a result that arrives below the reader.
const anchorSessionId = 'e2e-live-anchor';

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
  // A long Codex session: 250 items, with injected instructions near the end.
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, live_status, last_item_at, integration_mode, fidelity, capabilities_json
    ) VALUES (?, 'agentmonitor', 'codex', 'Long run', '2026-03-24T10:00:00.000Z', NULL, 250, 0, 'live',
      '2026-03-24T12:00:00.000Z', 'codex-jsonl', 'summary', ?)
  `).run(longSessionId, JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'none', live_items: 'summary' }));
  const longTurn = db.prepare(`
    INSERT INTO session_turns (session_id, agent_type, source_turn_id, status, title)
    VALUES (?, 'codex', ?, 'completed', 't')
  `);
  const longItem = db.prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at)
    VALUES (?, ?, 0, ?, ?, 'success', ?, ?)
  `);
  for (let n = 1; n <= 250; n++) {
    const turnId = Number(longTurn.run(longSessionId, `codex-message:${n}`).lastInsertRowid);
    const instructions = n === 248;
    longItem.run(
      longSessionId, turnId, `codex-message:${n}:item:0`,
      instructions ? 'instructions' : 'assistant_message',
      JSON.stringify({ text: instructions ? '<permissions instructions>sandboxed</permissions instructions>' : `Long item ${n}` }),
      new Date(Date.parse('2026-03-24T10:00:00.000Z') + n * 1000).toISOString(),
    );
  }

  const secondsAgo = (n: number) => new Date(Date.now() - n * 1000).toISOString();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, live_status, last_item_at, integration_mode, fidelity, capabilities_json
    ) VALUES (?, 'agentmonitor', 'claude', 'Anchor run', '2026-03-24T10:00:00.000Z', NULL, 60, 0, 'live',
      '2026-03-24T11:00:00.000Z', 'claude-jsonl', 'full', ?)
  `).run(anchorSessionId, JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' }));
  const anchorTurn = Number(db.prepare(`
    INSERT INTO session_turns (session_id, agent_type, source_turn_id, status, title)
    VALUES (?, 'claude', 'anchor-turn', 'running', 'Anchor run')
  `).run(anchorSessionId).lastInsertRowid);
  // Item 20 is an open call below the rows a test reads; item 55 one above them.
  const anchorCalls: Record<number, { id: string; command: string }> = {
    20: { id: 'toolu_anchor', command: 'long-running build' },
    55: { id: 'toolu_anchor_above', command: 'quick lint' },
  };
  for (let n = 1; n <= 60; n++) {
    const call = anchorCalls[n];
    longItem.run(
      anchorSessionId, anchorTurn, call ? call.id : `anchor:${n}`,
      call ? 'tool_call' : 'assistant_message',
      JSON.stringify(call ? { tool_name: 'Bash', input: { command: call.command } } : { text: `Anchor item ${n}` }),
      new Date(Date.parse('2026-03-24T10:00:00.000Z') + n * 1000).toISOString(),
    );
  }

  // One event gives the Monitor's filter bar an Agent option to show. It is
  // backdated so an event a test posts later always sorts as the newest.
  db.prepare(`
    INSERT INTO events (session_id, agent_type, event_type, tool_name, status, project, created_at, metadata, source)
    VALUES (?, 'claude_code', 'tool_use', 'Read', 'success', 'card-full-stream', ?, '{}', 'api')
  `).run(sessionId, secondsAgo(5));
  // The followed session's figures and recent events: usage, then a timed command.
  const insertEvent = db.prepare(`
    INSERT INTO events (session_id, agent_type, event_type, tool_name, status, project, created_at, metadata, source,
      tokens_in, tokens_out, cost_usd, model, duration_ms)
    VALUES (?, 'claude_code', ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, ?)
  `);
  insertEvent.run(sessionId, 'llm_response', null, 'success', 'card-full-stream', secondsAgo(30), '{}',
    1200, 300, 1.25, 'claude-opus-4-7', null);
  insertEvent.run(sessionId, 'tool_use', 'Bash', 'error', 'card-full-stream', secondsAgo(20),
    JSON.stringify({ command: 'pnpm test --filter monitor' }), 0, 0, null, null, 1500);
  insertEvent.run(noLiveSessionId, 'tool_use', 'Bash', 'success', 'card-no-stream', secondsAgo(10),
    JSON.stringify({ command: 'git log --oneline' }), 0, 0, null, null, 2500);

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
  // The agent filter stays in view: it still scopes the stats above the stream.
  await expect(page.getByTestId('filter-bar').getByRole('combobox', { name: 'Filter by agent' })).toBeVisible();

  // The card's figures stay in view while you follow the session.
  const summary = page.getByTestId('session-summary');
  await expect(summary).toContainText('3 events');
  await expect(summary).toContainText('1.2K in');
  await expect(summary).toContainText('300 out');
  await expect(summary).toContainText('main');
  await expect(summary).toContainText('Claude Code (claude-opus-4-7)');
  await expect(page.getByTestId('session-summary-cost')).toHaveText('$1.25');

  // The Inspector lists the session's recent events, newest first, with what each did and how long it took.
  const inspector = page.locator('aside', { has: page.getByRole('heading', { name: 'Inspector' }) });
  await inspector.getByRole('button', { name: 'Events', exact: true }).click();
  const events = inspector.getByRole('list', { name: 'Recent events' }).getByRole('listitem');
  await expect(events).toHaveCount(3);
  await expect(events.nth(0)).toContainText('tool_use › Read');
  await expect(events.nth(1)).toContainText('tool_use › Bash');
  await expect(events.nth(1)).toContainText('error');
  await expect(events.nth(1)).toContainText('pnpm test --filter monitor');
  await expect(events.nth(1)).toContainText('1.5s');
  await expect(events.nth(2)).toContainText('llm_response');

  // A live event lands at the top of the list and in the figures, without a reload.
  const posted = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      agent_type: 'claude_code',
      event_type: 'tool_use',
      tool_name: 'Grep',
      status: 'success',
      duration_ms: 250,
      cost_usd: 0.5,
      project: 'card-full-stream',
      metadata: { pattern: 'TODO' },
    }),
  });
  expect(posted.ok).toBe(true);
  await expect(events).toHaveCount(4);
  await expect(events.first()).toContainText('tool_use › Grep');
  await expect(events.first()).toContainText('TODO');
  await expect(events.first()).toContainText('250ms');
  await expect(summary).toContainText('4 events');
  await expect(page.getByTestId('session-summary-cost')).toHaveText('$1.75');

  // Other sessions' activity can fill the Monitor's global feed; this session's events stay.
  // Paced in small batches so the SSE connection never backs up and reconnects (a
  // reconnect rereads the session, which would hide a lost event).
  for (let batch = 0; batch < 21; batch++) {
    const flood = await fetch(`${baseUrl}/api/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: Array.from({ length: 10 }, (_, n) => ({
          session_id: 'e2e-busy-neighbour',
          agent_type: 'codex',
          event_type: 'tool_use',
          tool_name: 'exec_command',
          status: 'success',
          metadata: { command: `neighbour ${batch * 10 + n}` },
        })),
      }),
    });
    expect(flood.ok).toBe(true);
    await page.waitForTimeout(50);
  }
  await expect(page.getByTestId('filter-bar')).toContainText(/Events\s*215\b/);
  await page.waitForTimeout(500);
  await expect(events).toHaveCount(4);
  await expect(events.first()).toContainText('tool_use › Grep');
  // Picking an item in the stream shows it again.
  await page.locator('button', { hasText: 'Initial live response from seeded session' }).click();
  await expect(inspector.getByRole('heading', { name: 'Payload' })).toBeVisible();

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

test('a card with no live record shows its recent events in place', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);
  await card(page, 'card-no-stream').click();

  await expect(page).toHaveURL(new RegExp(`#monitor\\?session=${noLiveSessionId}$`));
  await expect(page.getByRole('heading', { name: 'Recent events' })).toBeVisible();
  await expect(page.getByText('No live stream for this session.')).toBeVisible();
  const events = page.getByRole('list', { name: 'Recent events' }).getByRole('listitem');
  await expect(events).toHaveCount(1);
  await expect(events.first()).toContainText('tool_use › Bash');
  await expect(events.first()).toContainText('git log --oneline');
  await expect(events.first()).toContainText('2.5s');
  await expect(page.getByTestId('session-summary')).toContainText('1 event');
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
  // The call ran from 12:00:07 to its result at 12:00:08.
  await expect(row).toContainText('1.0s');
  // The result has no row of its own, and success is left unsaid.
  await expect(page.locator('button', { hasText: 'nothing to commit, working tree clean' })).toHaveCount(1);
  const stream = page.locator('section', { has: page.getByRole('heading', { name: 'Inspect the repo' }) });
  await expect(stream.getByText('success', { exact: true })).toHaveCount(0);

  await row.click();
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
  const inspector = page.locator('aside', { has: page.getByRole('heading', { name: 'Inspector' }) });
  await expect(inspector.locator('div', { hasText: /^Took/ })).toContainText('1.0s');
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

test('with the live view turned off, a card opens its recent events in place', async ({ page }) => {
  await page.route('**/api/v2/live/settings', route => route.fulfill({
    json: {
      enabled: false,
      codex_mode: 'otel-only',
      capture: { prompts: true, reasoning: true, tool_arguments: true },
      diff_payload_max_bytes: 32768,
    },
  }));

  // A session that has a live stream still shows only its events: there is nothing to follow.
  await page.goto(`${baseUrl}/app/`);
  await card(page, 'card-summary-stream').click();
  await expect(page).toHaveURL(new RegExp(`#monitor\\?session=${summarySessionId}$`));
  await expect(page.getByText('The live view is off')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent events' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review OTEL stream' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Capture/ })).toHaveCount(0);
  await expect(page.getByTestId('session-summary')).toContainText('0 events');

  await page.getByRole('button', { name: '← Active agents' }).click();
  await expect(card(page, 'card-summary-stream')).toBeVisible();
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

test('a result folding into a call above or below the reader leaves the rows being read in place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/app/#monitor?session=${anchorSessionId}`);
  const stream = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Anchor run' }) });
  const scroller = stream.getByTestId('live-stream-scroller');
  const reading = stream.getByText('Anchor item 50', { exact: true });
  await expect(reading).toBeVisible();

  // Scroll so item 50 heads the viewport; the open call (item 20) is well below it.
  await scroller.evaluate((el) => {
    const row = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Anchor item 50'));
    // A whole pixel: Chrome snaps a fractional offset when the content height
    // changes, which would read as a pixel of drift.
    if (row) el.scrollTop = Math.round(el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top);
  });
  const call = stream.locator('button', { hasText: 'long-running build' });
  await expect(call).not.toBeInViewport();
  // Rows slide in as they render; measure once they have settled.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const before = (await reading.boundingBox())!.y;

  // Its result folds into that call's row and makes it taller; nothing above the reader changed.
  getDb().prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at)
    VALUES (?, (SELECT id FROM session_turns WHERE session_id = ?), 0, 'toolu_anchor', 'tool_result', 'success', ?, '2026-03-24T11:00:00.000Z')
  `).run(anchorSessionId, anchorSessionId, JSON.stringify({ content: 'Build finished: 412 modules compiled, 0 warnings, artifacts written to dist/ and ready for the next stage of the pipeline run' }));
  liveBroadcaster.broadcast('item_delta', { session_id: anchorSessionId, inserted_items: 1, last_item_at: '2026-03-24T11:00:00.000Z' });
  await expect(call).toContainText('Build finished');
  await expect.poll(async () => Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(2);

  // A result for the call above the reader makes that row taller: the rows being read still stay put.
  const above = stream.locator('button', { hasText: 'quick lint' });
  await expect(above).not.toBeInViewport();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const beforeAbove = (await reading.boundingBox())!.y;
  getDb().prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at)
    VALUES (?, (SELECT id FROM session_turns WHERE session_id = ?), 0, 'toolu_anchor_above', 'tool_result', 'success', ?, '2026-03-24T11:00:01.000Z')
  `).run(anchorSessionId, anchorSessionId, JSON.stringify({ content: 'Lint passed: 0 problems found across every package in the workspace, including the frontend and the CLI entry points' }));
  liveBroadcaster.broadcast('item_delta', { session_id: anchorSessionId, inserted_items: 1, last_item_at: '2026-03-24T11:00:01.000Z' });
  await expect(above).toContainText('Lint passed');
  await expect.poll(async () => Math.abs((await reading.boundingBox())!.y - beforeAbove)).toBeLessThan(2);
});

test('a long stream shows its newest item first and loads older ones below without losing your place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Arrive from another session whose Inspector was showing its events: a new session opens on its details.
  await page.goto(`${baseUrl}/app/#monitor?session=${sessionId}`);
  const inspector = page.locator('aside', { has: page.getByRole('heading', { name: 'Inspector' }) });
  await inspector.getByRole('button', { name: 'Events', exact: true }).click();
  await expect(inspector.getByRole('list', { name: 'Recent events' })).toBeVisible();
  await page.goto(`${baseUrl}/app/#monitor?session=${longSessionId}`);
  const stream = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Long run' }) });
  const scroller = stream.getByTestId('live-stream-scroller');
  await expect(inspector.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // The Monitor never recorded this session, so it has no events: said plainly, not as an error.
  await inspector.getByRole('button', { name: 'Events', exact: true }).click();
  await expect(inspector.getByText('No events recorded for this session.')).toBeVisible();
  await expect(inspector.getByText(/failed|Couldn't/)).toHaveCount(0);

  await expect(stream.getByText('Long item 250', { exact: true })).toBeInViewport();
  await expect(stream.getByText('Long item 1', { exact: true })).toHaveCount(0);
  await expect(stream.getByText('100 of 250 items')).toBeVisible();
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(0);
  // Newest first: 250 sits above 249.
  const top250 = await stream.getByText('Long item 250', { exact: true }).boundingBox();
  const top249 = await stream.getByText('Long item 249', { exact: true }).boundingBox();
  expect(top250!.y).toBeLessThan(top249!.y);

  // Codex's injected instructions read as such, not as the assistant.
  const instructions = stream.getByRole('button', { name: /^Instructions.*permissions instructions/ });
  await expect(instructions).toHaveCount(1);

  // Scrolling down to the bottom loads the page before, and the oldest row shown stays put.
  // Reaching the "Load older items" control already starts that load (a click there
  // races it), so the scroll is the gesture under test: one page, not two.
  await stream.getByRole('button', { name: 'Load older items' }).scrollIntoViewIfNeeded();
  await expect(stream.getByText('200 of 250 items')).toBeVisible();
  await expect(stream.getByText('Long item 60', { exact: true })).toHaveCount(1);
  await expect(stream.getByText('Long item 151', { exact: true })).toBeInViewport();

  // Scrolled down, a new item arrives at the top without moving the rows you are reading.
  const db = getDb();
  const lastTurn = db.prepare('SELECT id FROM session_turns WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(longSessionId) as { id: number };
  db.prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at)
    VALUES (?, ?, 1, 'codex-message:251:item:0', 'assistant_message', 'success', ?, '2026-03-24T12:00:01.000Z')
  `).run(longSessionId, lastTurn.id, JSON.stringify({ text: 'Long item 251' }));
  const reading = stream.getByText('Long item 151', { exact: true });
  const before = (await reading.boundingBox())!.y;
  liveBroadcaster.broadcast('item_delta', { session_id: longSessionId, inserted_items: 1, last_item_at: '2026-03-24T12:00:01.000Z' });
  await expect(stream.getByText('Long item 251', { exact: true })).toHaveCount(1);
  await expect(stream.getByText('Long item 251', { exact: true })).not.toBeInViewport();
  await expect.poll(async () => Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(2);

  // Back at the top, the newest item is the first row, and the next one to arrive shows there.
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(stream.getByText('Long item 251', { exact: true })).toBeInViewport();
  db.prepare(`
    INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at)
    VALUES (?, ?, 2, 'codex-message:252:item:0', 'assistant_message', 'success', ?, '2026-03-24T12:00:02.000Z')
  `).run(longSessionId, lastTurn.id, JSON.stringify({ text: 'Long item 252' }));
  liveBroadcaster.broadcast('item_delta', { session_id: longSessionId, inserted_items: 1, last_item_at: '2026-03-24T12:00:02.000Z' });
  await expect(stream.getByText('Long item 252', { exact: true })).toBeInViewport();
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(0);

  // The Messages filter selects messages (it once matched no stored kind) and leaves instructions out.
  await stream.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(stream.getByText('Long item 250', { exact: true })).toBeVisible();
  await expect(instructions).toHaveCount(0);
});
