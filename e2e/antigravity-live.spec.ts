import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { useIsolatedDb } from './isolated-db.js';

let tempDir = '';
let baseUrl = '';
let server: Server;
/* eslint-disable @typescript-eslint/consistent-type-imports */
let closeDb: typeof import('../src/db/connection.js').closeDb;
/* eslint-enable @typescript-eslint/consistent-type-imports */

function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let b = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) b |= 0x80;
    out.push(b);
  } while (big > 0);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const vField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];
const lField = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const sField = (f: number, s: string) => lField(f, [...Buffer.from(s, 'utf-8')]);
const stepBlob = (type: number, oneof: number) =>
  Buffer.from([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, [...vField(1, 1)])]);
const metaBlob = (secs: number) => Buffer.from(lField(1, [...vField(1, secs)]));
const genBlob = (model: string, prompt: number) =>
  Buffer.from(lField(1, [
    ...sField(19, model),
    ...lField(4, [...vField(1, 0), ...vField(2, prompt), ...vField(3, 120), ...vField(5, 0), ...vField(9, 0), ...vField(10, 120)]),
  ]));

const ROOT_ID = 'aaaa1111-f064-496b-ba70-c2d0993bc5ee';
const CHILD_ID = 'bbbb2222-d203-413c-875f-5add83617b2a';

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }
  tempDir = await useIsolatedDb('agentmonitor-e2e-antigravity-live-');

  const { initSchema } = await import('../src/db/schema.js');
  const { getDb, closeDb: closeDbFn } = await import('../src/db/connection.js');
  const { syncAllAntigravityFiles } = await import('../src/watcher/index.js');
  const { createApp } = await import('../src/app.js');
  closeDb = closeDbFn;

  initSchema();

  const agrHome = path.join(tempDir, 'antigravity-home');
  const convDir = path.join(agrHome, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const nowSecs = Math.floor(Date.now() / 1000) - 30;
  for (const [id, prompt] of [[ROOT_ID, 355910], [CHILD_ID, 18000]] as const) {
    const db = new Database(path.join(convDir, `${id}.db`));
    db.exec('CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
    db.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB);');
    db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, stepBlob(14, 19), metaBlob(nowSecs));
    db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)')
      .run(0, genBlob('gemini-4-neon', prompt));
    db.close();
  }

  const rootTranscript = path.join(agrHome, 'brain', ROOT_ID, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(rootTranscript), { recursive: true });
  fs.writeFileSync(rootTranscript, [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date((nowSecs - 20) * 1000).toISOString(),
      content: '<USER_REQUEST>\nVerify harpy eagle instructions routing\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal_time=now\n</ADDITIONAL_METADATA>',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date((nowSecs - 15) * 1000).toISOString(),
      model: 'gemini-4-neon',
      thinking: 'Inspecting custom instruction paths first.',
      content: 'Checked instruction routing successfully.',
      tool_calls: [{ name: 'read_file', args: { Path: '"/Users/example/Dev/sample-project/AGENTS.md"' } }],
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date((nowSecs - 10) * 1000).toISOString(),
      content: 'Read 42 lines from AGENTS.md.',
    }),
  ].join('\n') + '\n');

  const summaryDb = new Database(path.join(agrHome, 'conversation_summaries.db'));
  summaryDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      parent_conversation_id TEXT NOT NULL DEFAULT ''
    );
  `);
  summaryDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(
    ROOT_ID,
    'Configuring Custom Instructions Files',
    'Root preview',
    JSON.stringify(['file:///Users/example/Dev/sample-project']),
    '',
  );
  summaryDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(
    CHILD_ID,
    'Delegate research check',
    'Child preview',
    JSON.stringify(['file:///Users/example/Dev/sample-project']),
    ROOT_ID,
  );
  summaryDb.close();

  syncAllAntigravityFiles(getDb(), agrHome, {});

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const resetFiveHour = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  const resetWeekly = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  const statusRes = await fetch(`${baseUrl}/api/provider-quotas/antigravity/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: '/Users/example/Dev/sample-project',
      session_id: ROOT_ID,
      conversation_id: ROOT_ID,
      conversation_title: 'Configuring Custom Instructions Files',
      model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
      workspace: { current_dir: '/Users/example/Dev/sample-project', project_dir: '/Users/example/Dev/sample-project' },
      version: '1.5.15',
      context_window: {
        total_input_tokens: 355910,
        total_output_tokens: 103227,
        context_window_size: 1048576,
      },
      product: 'antigravity',
      quota: {
        '3p-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
        '3p-weekly': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
        'gemini-5h': { remaining_fraction: 0.9349563, reset_time: resetFiveHour, reset_in_seconds: 14400 },
        'gemini-weekly': { remaining_fraction: 0.6907192, reset_time: resetWeekly, reset_in_seconds: 432000 },
      },
      plan_tier: 'Google AI Pro',
      email: 'private@example.com',
      subagents: [{ name: 'self', role: 'multi-KB prompt omitted' }],
    }),
  });
  expect(statusRes.status).toBe(202);

  const eventRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: ROOT_ID,
      agent_type: 'antigravity',
      event_type: 'tool_use',
      tool_name: 'run_command',
      project: 'sample-project',
      model: 'gemini-4-neon',
    }),
  });
  expect(eventRes.status).toBe(201);
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('QuotaPill and Monitor card display live Antigravity quota and context occupancy', async ({ page }) => {
  await page.goto(`${baseUrl}/app/`);

  const pill = page.getByRole('button', { name: 'Quota left: Antigravity 69%' });
  await expect(pill).toBeVisible();
  await expect(pill.getByTitle('Antigravity', { exact: true }).locator('svg')).toBeVisible();

  await pill.click();
  const detail = page.getByRole('dialog', { name: 'Provider quota detail' });
  await expect(detail.getByRole('heading', { name: 'Antigravity', exact: true }).locator('svg')).toBeVisible();
  await expect(detail.getByText('Google AI Pro')).toBeVisible();
  await expect(detail.getByText('69% left')).toBeVisible();
  await expect(detail.getByText('94% left')).toBeVisible();
  await expect(detail.getByText(/1970|reset unavailable/)).toHaveCount(0);

  await pill.click();

  const card = page.locator('button', { hasText: 'sample-project' }).first();
  await expect(card).toBeVisible();
  await expect(card.locator('[title="Context: 355.9K / 1.0M tokens"]')).toBeVisible();
  await expect(card.getByText('34%')).toBeVisible();
});

test('Sessions list shows Antigravity summary title, project, and nested subagent lineage', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);

  const rootRow = page.getByRole('row', { name: /Configuring Custom Instructions Files/ });
  await expect(rootRow).toBeVisible();
  await expect(rootRow.getByRole('button', { name: /Configuring Custom Instructions Files/ })).toBeVisible();
  await expect(rootRow.getByRole('cell', { name: 'sample-project', exact: true })).toBeVisible();

  const toggle = page.getByRole('button', { name: '1 subagent' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /Delegate research check/ })).toBeVisible();
});

test('Sessions search and viewer display full-fidelity Antigravity transcript cleanly', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#sessions`);

  const searchInput = page.getByRole('searchbox', { name: 'Search transcripts' });
  await searchInput.fill('harpy');
  await searchInput.press('Enter');

  const hitButton = page.locator('button', { hasText: 'Configuring Custom Instructions Files' }).first();
  await expect(hitButton).toBeVisible();
  await hitButton.click();

  await expect(page.getByText('Verify harpy eagle instructions routing')).toBeVisible();
  await expect(page.getByText('<USER_REQUEST>')).toHaveCount(0);
  await expect(page.getByText('<ADDITIONAL_METADATA>')).toHaveCount(0);
  await expect(page.getByText('Checked instruction routing successfully.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full detail' })).toBeVisible();
  await page.getByRole('button', { name: 'Full detail' }).click();
  await expect(page.getByText('Antigravity transcript')).toBeVisible();
});
