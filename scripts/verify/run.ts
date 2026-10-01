import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { assertUsage, scenarioById, usageExpected, type Check, type Scenario } from './contracts.js';
import { control, provenance, readSession, repoRoot, startSession, StartupError, stopSession, writeJson, type Session } from './session.js';

export interface RunOptions { session?: string; maxApiMs?: number; maxUiMs?: number; signal?: AbortSignal }
export async function runScenario(id: Scenario, options: RunOptions = {}) {
  options = { ...options, signal: options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000) };
  const scenario = scenarioById(id);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-evidence-'));
  fs.chmodSync(directory, 0o700);
  const result = {
    schema_version: 1, scenario: id, fixture: scenario.fixture,
    status: 'blocked' as 'passed' | 'failed' | 'blocked',
    started_at: new Date().toISOString(), finished_at: '', directory,
    runtime: null as Session['provenance'] | null,
    session: null as string | null, browser: null as string | null,
    checks: scenario.checks.map(name => ({ name, status: 'not_run' } as Check)),
    measurements: {} as Record<string, unknown>,
    limits: [...scenario.limits, 'Compiled app and watcher fixture host; not amon serve, Portless, or live installation'],
    artifacts: [] as string[], errors: [] as string[],
    cleanup: 'not_started' as string,
  };
  let session: Session | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let locked = false;
  const observations: Record<string, unknown> = {};
  const browserLog: unknown[] = [];
  const artifact = (name: string) => path.join(directory, name);
  const persist = () => writeJson(artifact('result.json'), result);
  const interrupted = () => { void browser?.close().catch(() => {}); };
  const assertIdentity = () => {
    const current = provenance();
    for (const key of ['backend_sha256', 'frontend_sha256', 'verifier_sha256', 'benchmark_sha256', 'lockfile_sha256'] as const) {
      assert.equal(current[key], session!.provenance[key], `${key} changed since start; stop and start a new session`);
    }
  };
  async function check(name: string, action: () => Promise<void>) {
    options.signal?.throwIfAborted();
    const entry = result.checks.find(item => item.name === name)!;
    try { await action(); entry.status = 'passed'; }
    catch (error) { entry.status = 'failed'; entry.detail = String(error); throw error; }
    finally { persist(); }
  }
  async function api(route: string, label: string) {
    options.signal?.throwIfAborted();
    const response = await fetch(session!.url + route, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as Record<string, unknown>;
    observations[label] = { url: response.url, status: response.status, body };
    assert.equal(response.status, 200, `API ${route}`);
    return body;
  }
  async function screenshot(name: string) {
    await page!.screenshot({ path: artifact(name), fullPage: true, timeout: 5_000 });
    result.artifacts.push(artifact(name));
  }
  async function cards(expected: string[]) {
    for (const [index, label] of ['Total Cost', 'Input Tokens', 'Output Tokens', 'Usage Events'].entries()) {
      const card = page!.getByText(label, { exact: true }).locator('..');
      await expect(card.locator('span.tabular').first()).toHaveText(expected[index], { timeout: 10_000 });
      observations[`card:${label}`] = await card.innerText();
    }
  }
  persist();
  try {
    session = options.session ? readSession(options.session) : await startSession(options.signal);
    result.session = session.directory;
    result.runtime = session.provenance;
    result.cleanup = options.session ? 'retained' : 'pending';
    persist();
    assert.equal(session.status, 'running', 'Session must be running');
    await control(session, 'status');
    assertIdentity();
    fs.closeSync(fs.openSync(path.join(session.directory, 'verification.lock'), 'wx', 0o600));
    locked = true;
    options.signal?.throwIfAborted();
    browser = await chromium.launch({ timeout: 15_000 });
    result.browser = browser.version();
    options.signal?.addEventListener('abort', interrupted, { once: true });
    options.signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC', locale: 'en-US', serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === session!.url ? route.continue() : route.abort());
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    page.on('console', message => browserLog.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => browserLog.push({ type: 'pageerror', text: String(error) }));
    page.on('requestfailed', request => browserLog.push({ type: 'requestfailed', url: request.url(), error: request.failure() }));
    // From this point an unmet product expectation is a failure, not a missing prerequisite.
    result.status = 'failed';
    if (id === 'live-session') {
      const state = await control(session, 'status');
      const route = `/api/v2/live/sessions/${String(state.liveId)}/items`;
      await check('initial-api', async () => {
        const body = await api(route, 'initial-api');
        assert.ok(JSON.stringify(body).includes('Initial verification response'), 'Initial transcript projected');
      });
      await check('initial-browser', async () => {
        await page!.goto(session!.url + scenario.route);
        await page!.getByRole('button').filter({ hasText: 'Verify the live session' }).first().click();
        await expect(page!.getByText('Initial verification response', { exact: true }).first()).toBeVisible();
        await screenshot('before.png');
      });
      const documentId = await page.evaluate(() => performance.timeOrigin);
      const update = await control(session, 'advance');
      observations.advance = update;
      await check('updated-api', async () => {
        await expect.poll(async () => JSON.stringify(await api(route, 'updated-api')).includes(String(update.marker)), { timeout: 12_000 }).toBe(true);
      });
      await check('updated-browser', async () => {
        await expect(page!.getByText(String(update.marker), { exact: true }).first()).toBeVisible({ timeout: 12_000 });
        assert.equal(await page!.evaluate(() => performance.timeOrigin), documentId, 'Browser document must not reload');
        await screenshot('after.png');
      });
    } else {
      const route = '/api/v2/usage/overview?date_from=2026-07-01&date_to=2026-07-31';
      observations.expected = usageExpected;
      await check('totals-api', async () => assertUsage((await api(route, 'totals-api')).summary, usageExpected.all));
      const initialStarted = performance.now();
      await check('totals-browser', async () => {
        await page!.goto(session!.url + scenario.route);
        await cards(['$10.00', '100.0K', '20.0K', '1.0K']);
      });
      result.measurements.ui_initial_ms = performance.now() - initialStarted;
      await screenshot('before.png');
      await check('filtered-api', async () => assertUsage((await api(route + '&project=alpha', 'filtered-api')).summary, usageExpected.alpha));
      const filterStarted = performance.now();
      await check('filtered-browser', async () => {
        await page!.getByRole('combobox', { name: 'Filter by project' }).selectOption('alpha');
        await cards(['$6.00', '60.0K', '12.0K', '600']);
      });
      const filterMs = performance.now() - filterStarted;
      result.measurements.ui_filter_ms = filterMs;
      result.measurements.ui_policy = 'Single browser navigation/filter-to-asserted-cards sample, no warmup; not API latency';
      await screenshot('after.png');
      const benchmark = await promisify(execFile)(process.execPath, [
        '--import', 'tsx', 'scripts/benchmark-usage-overview.ts', '--base-url', session.url,
        '--date-from', '2026-07-01', '--date-to', '2026-07-31', '--warmups', '1', '--runs', '5',
      ], { cwd: repoRoot, timeout: 30_000, signal: options.signal });
      const measurement = JSON.parse(benchmark.stdout) as { median_ms: number };
      result.measurements.api = { ...measurement, passed: undefined, status: 'observed' };
      result.measurements.thresholds = { max_api_ms: options.maxApiMs ?? null, max_ui_ms: options.maxUiMs ?? null };
      if (options.maxApiMs !== undefined) assert.ok(measurement.median_ms <= options.maxApiMs, `API median ${measurement.median_ms} > ${options.maxApiMs} ms`);
      if (options.maxUiMs !== undefined) assert.ok(filterMs <= options.maxUiMs, `UI filter ${filterMs} > ${options.maxUiMs} ms`);
    }
    assertIdentity();
    options.signal?.throwIfAborted();
    result.status = 'passed';
  } catch (error) {
    if (options.signal?.aborted) result.status = 'blocked';
    if (error instanceof StartupError) {
      result.session = error.directory;
      result.runtime = error.identity;
      result.cleanup = 'host_exited';
      result.artifacts.push(path.join(error.directory, 'host.log'), path.join(error.directory, 'failure.json'));
    }
    result.errors.push(String(error));
    if (page && !page.isClosed()) await screenshot('failure.png').catch(error => result.errors.push(`Screenshot: ${String(error)}`));
  } finally {
    options.signal?.removeEventListener('abort', interrupted);
    try {
      if (context && browser?.isConnected()) {
        await context.tracing.stop({ path: artifact('trace.zip') });
        result.artifacts.push(artifact('trace.zip'));
      }
    } catch (error) { result.errors.push(`Trace: ${String(error)}`); }
    try { await browser?.close(); }
    catch (error) { result.errors.push(`Browser cleanup: ${String(error)}`); result.status = 'failed'; }
    if (locked) {
      try { fs.unlinkSync(path.join(session!.directory, 'verification.lock')); }
      catch (error) { result.errors.push(`Lock cleanup: ${String(error)}`); result.status = 'failed'; }
    }
    if (session && !options.session) {
      try { await stopSession(session); result.cleanup = 'stopped'; }
      catch (error) { result.cleanup = 'failed'; result.status = 'failed'; result.errors.push(`Host cleanup: ${String(error)}`); }
    }
    if (session) {
      const log = path.join(session.directory, 'host.log');
      if (fs.existsSync(log)) { fs.copyFileSync(log, artifact('host.log')); result.artifacts.push(artifact('host.log')); }
    }
    writeJson(artifact('observations.json'), observations);
    writeJson(artifact('browser.json'), browserLog);
    result.artifacts.push(artifact('observations.json'), artifact('browser.json'));
    result.finished_at = new Date().toISOString();
    persist();
  }
  return result;
}
