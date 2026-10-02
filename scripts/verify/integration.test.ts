import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { startSession, stopSession, control, readSession, repoRoot } from './session.js';
import { runScenario } from './run.js';

// Explicit opt-in: these checks require the compiled app and Chromium.
// Run serially; the mutation test temporarily changes one local dist file.

// Evidence and session directories outlive a run by design; the tests remove
// exactly the ones their runs report, never a prefix sweep of the temp dir.
const created = new Set<string>();
function keep<T extends { directory?: string; session?: string | null }>(result: T): T {
  for (const dir of [result.directory, result.session]) if (dir) created.add(dir);
  return result;
}
const removeCreated = () => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); };
const scenario = (...args: Parameters<typeof runScenario>) => runScenario(...args).then(keep);
const start = (...args: Parameters<typeof startSession>) => startSession(...args).then(keep);

test('verification pilot lifecycle, real workflows, and negative controls', { timeout: 120_000 }, async t => {
  t.after(removeCreated);
  await t.test('JSON discovery and invalid input need no server', () => {
    const invoke = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify/cli.ts', ...args, '--json'], { cwd: repoRoot, encoding: 'utf8' });
    const listing = invoke('list');
    assert.equal(listing.status, 0);
    assert.equal(JSON.parse(listing.stdout).scenarios.length, 2);
    for (const args of [['run', 'bogus'], ['start', '--session', 'oops'], ['run', 'usage', '--max-api-ms', '-1']]) {
      const rejected = invoke(...args);
      assert.equal(rejected.status, 2);
      assert.equal(keep(JSON.parse(rejected.stdout)).status, 'blocked');
    }
  });
  await t.test('separate sessions, authenticated control, ambient DB override, idempotent stop', async () => {
    const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-sentinel-'));
    const sentinelFile = path.join(sentinel, 'must-not-open.db');
    fs.writeFileSync(sentinelFile, 'unchanged');
    const previous = process.env.AGENTMONITOR_DB_PATH;
    process.env.AGENTMONITOR_DB_PATH = sentinelFile;
    const first = await start();
    let second: Awaited<ReturnType<typeof startSession>> | undefined;
    try {
      second = await start();
      assert.notEqual(first.url, second.url);
      assert.equal((await fetch(first.control_url + '/stop', { method: 'POST' })).status, 403);
      await control(first, 'status');
      await stopSession(first);
      assert.equal((await stopSession(first)).status, 'stopped');
      await assert.rejects(fetch(first.url, { signal: AbortSignal.timeout(1_000) }));
      await control(second, 'status');
      assert.equal(fs.readFileSync(sentinelFile, 'utf8'), 'unchanged');
      const live = await scenario('live-session', { session: second.directory });
      assert.equal(live.status, 'passed', JSON.stringify(live.errors));
      assert.equal(live.cleanup, 'retained');
      assert.equal(readSession(second.directory).status, 'running');
      t.diagnostic(`Live evidence: ${live.directory}`);
      const builtApp = path.join(repoRoot, 'dist/app.js');
      const originalBuild = fs.readFileSync(builtApp);
      try {
        fs.appendFileSync(builtApp, '\n// changed after session start\n');
        const stale = await scenario('usage', { session: second.directory });
        assert.equal(stale.status, 'blocked');
        assert.match(stale.errors.join(' '), /changed since start/);
      } finally { fs.writeFileSync(builtApp, originalBuild); }
      const interrupted = new AbortController();
      const pending = scenario('usage', { session: second.directory, signal: interrupted.signal });
      const timer = setTimeout(() => interrupted.abort(new Error('Test interruption')), 20);
      const result = await pending;
      clearTimeout(timer);
      assert.equal(result.status, 'blocked');
      await control(second, 'status');
      assert.equal(fs.existsSync(path.join(second.directory, 'verification.lock')), false);
    } finally {
      await stopSession(first);
      if (second) await stopSession(second);
      if (previous === undefined) delete process.env.AGENTMONITOR_DB_PATH; else process.env.AGENTMONITOR_DB_PATH = previous;
      fs.rmSync(sentinel, { recursive: true });
    }
  });
  await t.test('one-shot usage records API/UI evidence and closes its host', async () => {
    const result = await scenario('usage');
    assert.equal(result.status, 'passed', JSON.stringify(result.errors));
    assert.equal(result.cleanup, 'stopped');
    assert.equal(result.checks.every(check => check.status === 'passed'), true);
    assert.ok(result.artifacts.some(file => file.endsWith('trace.zip') && fs.statSync(file).size > 0));
    assert.ok(Number(result.measurements.ui_filter_ms) > 0);
    await assert.rejects(fetch(readSession(result.session!).url, { signal: AbortSignal.timeout(1_000) }));
    t.diagnostic(`Usage evidence: ${result.directory}`);
  });
  await t.test('one-shot interruption retains evidence and stops the owned host', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const abort = new AbortController();
    const pending = scenario('usage', { signal: abort.signal });
    const timer = setInterval(() => {
      for (const entry of fs.readdirSync(os.tmpdir())) {
        if (before.has(entry) || !entry.startsWith('agentmonitor-evidence-')) continue;
        const file = path.join(os.tmpdir(), entry, 'result.json');
        if (!fs.existsSync(file)) continue;
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current.session) abort.abort(new Error('Test interruption after host readiness'));
      }
    }, 10);
    try {
      const result = await pending;
      assert.equal(result.status, 'blocked');
      assert.equal(result.cleanup, 'stopped');
      assert.equal(readSession(result.session!).status, 'stopped');
    } finally { clearInterval(timer); }
  });
  await t.test('unattainable explicit timing budget fails after correctness passes', async () => {
    const result = await scenario('usage', { maxApiMs: 0.000001 });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => error.includes('API median')));
    assert.equal(result.checks.every(check => check.status === 'passed'), true);
    assert.equal(result.cleanup, 'stopped');
  });
  await t.test('plausible wrong compiled total fails with actual and expected values', async () => {
    const file = path.join(repoRoot, 'dist/db/v2-queries.js');
    const original = fs.readFileSync(file, 'utf8');
    const target = 'total_usage_events: rows.length,';
    assert.equal(original.split(target).length, 2, 'Mutation must hit one real aggregation');
    try {
      fs.writeFileSync(file, original.replace(target, 'total_usage_events: rows.length - 1,'));
      const result = await scenario('usage');
      assert.equal(result.status, 'failed');
      assert.equal(result.checks[0].status, 'failed');
      assert.match(result.checks[0].detail!, /999 !== 1000/);
      assert.equal(result.cleanup, 'stopped');
      const observations = JSON.parse(fs.readFileSync(path.join(result.directory, 'observations.json'), 'utf8'));
      assert.equal(observations['totals-api'].body.summary.total_usage_events, 999);
      t.diagnostic(`Mutation evidence: ${result.directory}`);
    } finally { fs.writeFileSync(file, original); }
  });
  await t.test('missing build and browser are blocked, with remaining checks not run', async () => {
    const file = path.join(repoRoot, 'dist/app.js');
    fs.renameSync(file, file + '.verification-test');
    try {
      const result = await scenario('usage');
      assert.equal(result.status, 'blocked');
      assert.equal(result.cleanup, 'not_started');
      assert.ok(result.checks.every(check => check.status === 'not_run'));
    } finally { fs.renameSync(file + '.verification-test', file); }
    const builtApp = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, 'intentionally invalid JavaScript syntax');
      const result = await scenario('usage');
      assert.equal(result.status, 'blocked');
      assert.equal(result.cleanup, 'host_exited');
      assert.ok(result.artifacts.some(artifact => artifact.endsWith('host.log')));
    } finally { fs.writeFileSync(file, builtApp); }
    const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-browser-'));
    try {
      // Separate process: Playwright reads its browser path at module import.
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify/cli.ts', 'run', 'usage', '--json'], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
      });
      assert.equal(result.status, 2, result.stderr);
      const evidence = keep(JSON.parse(result.stdout));
      assert.equal(evidence.status, 'blocked');
      assert.equal(evidence.cleanup, 'stopped');
      assert.ok(evidence.errors.some((error: string) => error.includes("Executable doesn't exist")));
    } finally {
      if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = original;
      fs.rmSync(empty, { recursive: true });
    }
  });
});
