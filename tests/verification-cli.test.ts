import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { assertUsage, usageExpected, scenarioById } from '../scripts/verify/contracts.js';
import { probeById, resolveTarget, snapshotPrefix } from '../scripts/verify/probe.js';
import { openReadOnly } from '../scripts/verify/readonly.js';

test('usage oracle rejects a believable missing event, wrong cost, and malformed result', () => {
  assertUsage({ ...usageExpected.all }, usageExpected.all);
  assert.throws(() => assertUsage({ ...usageExpected.all, total_usage_events: 999 }, usageExpected.all));
  assert.throws(() => assertUsage({ ...usageExpected.all, total_cost_usd: 0 }, usageExpected.all));
  assert.throws(() => assertUsage({}, usageExpected.all));
});

test('discovery rejects unsupported scenarios', () => {
  assert.equal(scenarioById('usage').fixture, 'usage-1000-v1');
  assert.throws(() => scenarioById('all'));
});

describe('verification probes', () => {
  const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verification-probe-test-'));

  test('the read-only opener refuses writes', () => {
    const dir = temp();
    try {
      const file = path.join(dir, 'probe.db');
      const setup = new Database(file);
      setup.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)');
      setup.close();
      const db = openReadOnly(file);
      // Each layer alone refuses writes; check both are in place.
      assert.equal(db.readonly, true);
      assert.equal(db.pragma('query_only', { simple: true }), 1);
      assert.throws(() => db.prepare('INSERT INTO t VALUES (2)').run(), /readonly|query_only/i);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 1);
      db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('resync writes only to a scratch database or a snapshot made by the CLI', () => {
    const evidence = temp();
    const outside = temp();
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
    try {
      const resync = probeById('resync');
      const scratch = resolveTarget(resync, {}, evidence)!;
      assert.equal(scratch.kind, 'scratch');
      assert.equal(path.dirname(scratch.path), evidence);

      const other = path.join(outside, 'agentmonitor.db');
      fs.writeFileSync(other, '');
      assert.throws(() => resolveTarget(resync, { db: other }, evidence), /must be a snapshot/);

      const copy = path.join(snapshot, 'agentmonitor.db');
      fs.writeFileSync(copy, '');
      assert.equal(resolveTarget(resync, { db: copy }, evidence)!.kind, 'snapshot');
    } finally {
      for (const dir of [evidence, outside, snapshot]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plans runs only on a snapshot made by the CLI', () => {
    const evidence = temp();
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), snapshotPrefix));
    try {
      const plans = probeById('plans');
      assert.throws(() => resolveTarget(plans, {}, evidence), /must be a snapshot/);
      const other = path.join(evidence, 'agentmonitor.db');
      fs.writeFileSync(other, '');
      assert.throws(() => resolveTarget(plans, { db: other }, evidence), /must be a snapshot/);
      const copy = path.join(snapshot, 'agentmonitor.db');
      fs.writeFileSync(copy, '');
      assert.equal(resolveTarget(plans, { db: copy }, evidence)!.kind, 'snapshot');
    } finally {
      for (const dir of [evidence, snapshot]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plans needs exactly one index option', () => {
    const invoke = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify/cli.ts', 'probe', ...args, '--json'], { encoding: 'utf8' });
    for (const args of [['plans', '--db', 'x'], ['plans', '--db', 'x', '--index', 'a', '--index-sql', 'CREATE INDEX b ON t(c)'], ['health', '--index', 'a']]) {
      const result = invoke(...args);
      assert.equal(result.status, 2, result.stderr);
      assert.match(JSON.parse(result.stdout).error, /index/);
    }
  });

  test('read probes label an explicit database and reject a missing one', () => {
    const dir = temp();
    try {
      const file = path.join(dir, 'other.db');
      fs.writeFileSync(file, '');
      const target = resolveTarget(probeById('monitor-stats'), { db: file }, dir)!;
      assert.deepEqual([target.kind, target.path], ['explicit', fs.realpathSync(file)]);
      assert.throws(() => resolveTarget(probeById('ingestion'), { db: path.join(dir, 'missing.db') }, dir), /does not exist/);
      assert.throws(() => probeById('all'), /Unknown probe/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
