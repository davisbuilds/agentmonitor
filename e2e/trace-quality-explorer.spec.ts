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

  // A second trace in a different session: lets the hash deep-link test switch the
  // open trace via an external hashchange. e2e-sess-1 keeps exactly one trace, so
  // the session-scope auto-open test still applies.
  db.prepare(`
    INSERT INTO trace_quality_traces (id, session_id, agent_type, name, status, started_at, coverage_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'e2e-trace-2', 'e2e-sess-2', 'codex', 'Second explorer trace', 'success', now,
    JSON.stringify({ has_full_transcript: true, has_tool_details: true, has_token_usage: true, has_cost: true, projection_confidence: 'high' }),
  );
  insertObs.run('e2e-obs-2-root', 'e2e-trace-2', null, 'e2e-sess-2', 'event', 'generation', 'Second root generation', 'success', 'gpt-5', null, now, 1000, 200, 50, 0.01);
  // An error observation on trace-2 so the dashboards produce an inspectable finding.
  insertObs.run('e2e-obs-2-err', 'e2e-trace-2', 'e2e-obs-2-root', 'e2e-sess-2', 'event', 'tool', 'Failing tool', 'error', null, 'Bash', now, 500, 0, 0, null);

  // A machine-authored score on trace-1. The local-review panel must hide it (and
  // its destructive Remove) because that surface only owns human-authored scores.
  db.prepare(`
    INSERT INTO trace_quality_scores (target_type, target_id, name, value_type, boolean_value, source, evaluator_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('trace', 'e2e-trace-1', 'machine-correctness', 'boolean', 1, 'code_evaluator', 'builtin');

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

test('quality explorer scopes to a session via drill-in and auto-opens a lone trace', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=quality&session=e2e-sess-1`);

  await expect(page.getByText(/Scoped to session/)).toBeVisible();
  // The session has exactly one trace, so it opens automatically.
  await expect(page.getByRole('heading', { name: 'Seeded explorer trace' })).toBeVisible();
  await expect(page.getByText('Root generation')).toBeVisible();

  // Clearing the scope drops back to the date-filtered list.
  await page.getByRole('button', { name: 'Clear scope' }).click();
  await expect(page.getByText(/Scoped to session/)).toHaveCount(0);
});

test('quality explorer hides machine-authored scores from the local review panel', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=quality&trace=e2e-trace-1`);
  await expect(page.getByRole('heading', { name: 'Seeded explorer trace' })).toBeVisible();

  // The local-review panel is mounted...
  await expect(page.getByRole('heading', { name: 'Local review scores' })).toBeVisible();
  // ...but the seeded code_evaluator score is filtered out, so it has no destructive Remove.
  await expect(page.getByText('machine-correctness')).toHaveCount(0);

  // A human score, by contrast, shows and is removable — proving the panel renders
  // scores and only filters by source.
  await page.getByPlaceholder('Score name (e.g. correctness)').fill('human-correctness');
  await page.getByRole('button', { name: 'Add score', exact: true }).click();
  const scoreRow = page.locator('li', { hasText: 'human-correctness' });
  await expect(scoreRow).toBeVisible();
  await scoreRow.getByRole('button', { name: /Delete score human-correctness/ }).click();
  await expect(page.locator('li', { hasText: 'human-correctness' })).toHaveCount(0);
});

test('quality explorer reloads the inspector when the trace hash changes externally', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=quality&trace=e2e-trace-1`);
  await expect(page.getByRole('heading', { name: 'Seeded explorer trace' })).toBeVisible();
  await expect(page.getByText('Root generation')).toBeVisible();

  // An external nav (Back/Forward or an edited URL) that changes only `trace=`.
  // Assigning location.hash fires a real hashchange, unlike in-app replaceState.
  await page.evaluate(() => {
    window.location.hash = 'analytics?view=quality&trace=e2e-trace-2';
  });

  // The inspector follows the hash to the new trace.
  await expect(page.getByRole('heading', { name: 'Second explorer trace' })).toBeVisible();
  await expect(page.getByText('Second root generation')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seeded explorer trace' })).toHaveCount(0);
});

test('quality dashboards show findings, prompt rollups, and score trends, and inspect opens a trace', async ({ page }) => {
  await page.goto(`${baseUrl}/app/#analytics?view=quality`);
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click();

  // All three dashboard sections render.
  await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prompt versions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Score trends' })).toBeVisible();

  // Score trends aggregate all scores, including machine-authored ones that the
  // human-review panel hides.
  await expect(page.getByText('machine-correctness')).toBeVisible();

  // Narrow findings to the seeded error via the kind filter, then inspect it: the
  // view jumps to the explorer with the impacted trace open.
  await page.getByLabel('Filter findings by kind').selectOption('observation_error');
  await expect(page.getByText('Failing tool reported error')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Second explorer trace' })).toBeVisible();
  await expect(page.getByText('Failing tool')).toBeVisible();
});
