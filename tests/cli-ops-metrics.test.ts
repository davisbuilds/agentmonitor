import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { before } from 'node:test';

import { formatAttrs, formatOpsMetrics } from '../src/cli/formatters/ops.js';
import { resolveSince } from '../src/cli/commands/ops.js';
import type { OperationalMetricSummaryRow } from '../src/db/v2-queries.js';

// --- Relative --since resolution (pure) -----------------------------------

test('resolveSince converts a relative shorthand to now - duration', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  assert.equal(resolveSince('1h', now), '2026-09-11T11:00:00.000Z');
  assert.equal(resolveSince('30m', now), '2026-09-11T11:30:00.000Z');
  assert.equal(resolveSince('7d', now), '2026-09-04T12:00:00.000Z');
  assert.equal(resolveSince('2w', now), '2026-08-28T12:00:00.000Z');
  assert.equal(resolveSince('90s', now), '2026-09-11T11:58:30.000Z');
});

test('resolveSince passes through an absolute ISO value and undefined', () => {
  assert.equal(resolveSince('2026-09-01T00:00:00Z'), '2026-09-01T00:00:00Z');
  assert.equal(resolveSince('2026-09-11 10:00:00'), '2026-09-11 10:00:00');
  assert.equal(resolveSince(undefined), undefined);
});

test('resolveSince rejects a malformed --since instead of silently matching nothing', () => {
  // A typo'd absolute value would make SQLite datetime() return NULL, yielding
  // an empty result that falsely implies no events occurred.
  assert.throws(() => resolveSince('notadate'), /--since/);
  assert.throws(() => resolveSince('2026-13-40'), /--since/);
});

// --- Pure formatter behavior (the TDD unit) -------------------------------

test('formatAttrs renders sorted k=v and a dash for no attrs', () => {
  assert.equal(formatAttrs({ state: 'succeeded' }), 'state=succeeded');
  // Keys are sorted so the same bag always renders identically.
  assert.equal(formatAttrs({ state: 'skipped', reason: 'rate_limit' }), 'reason=rate_limit state=skipped');
  assert.equal(formatAttrs(null), '-');
  assert.equal(formatAttrs({}), '-');
});

test('formatOpsMetrics renders a header, one row per metric, and its attrs', () => {
  const rows: OperationalMetricSummaryRow[] = [
    { metric_name: 'codex.memory.startup', attrs: { state: 'succeeded' }, occurrences: 3, total_value: 3, last_seen: '2026-09-11 10:00:00' },
    { metric_name: 'codex.memory.startup', attrs: { state: 'skipped_rate_limit' }, occurrences: 1, total_value: 1, last_seen: '2026-09-11 09:00:00' },
  ];
  const out = formatOpsMetrics(rows);
  assert.match(out, /METRIC_NAME/);
  assert.match(out, /codex\.memory\.startup/);
  assert.match(out, /state=succeeded/);
  assert.match(out, /state=skipped_rate_limit/);
});

test('formatOpsMetrics reports an empty result rather than a bare header', () => {
  assert.equal(formatOpsMetrics([]), '(no rows)');
});

// --- End-to-end command wiring --------------------------------------------

class CaptureStream extends Writable {
  output = '';
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

async function runCli(args: string[]) {
  const { main } = await import('../src/cli.js');
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await main(['/usr/local/bin/node', '/repo/dist/cli.js', ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

let tempDir = '';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-ops-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

  const { initSchema } = await import('../src/db/schema.js');
  const { getDb } = await import('../src/db/connection.js');
  initSchema();
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO otel_metrics (session_id, agent_type, metric_name, attrs, value, temporality, created_at, client_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('s1', 'codex', 'codex.memory.startup', JSON.stringify({ state: 'succeeded' }), 1, 'delta', '2026-09-11 10:00:00', '2026-09-11T10:00:00Z');
  insert.run('s1', 'codex', 'codex.memory.startup', JSON.stringify({ state: 'succeeded' }), 1, 'delta', '2026-09-11 10:05:00', '2026-09-11T10:05:00Z');
  insert.run('s1', 'codex', 'codex.memory.startup', JSON.stringify({ state: 'skipped_rate_limit' }), 1, 'delta', '2026-09-11 09:00:00', '2026-09-11T09:00:00Z');
  insert.run('s2', 'claude_code', 'claude.tool.decision', JSON.stringify({ decision: 'accept' }), 1, 'delta', '2026-09-11 08:00:00', '2026-09-11T08:00:00Z');
});

test('ops metrics --json emits the grouped summary rows', async () => {
  const { stdout, exitCode } = await runCli(['ops', 'metrics', '--json']);
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout) as { metrics: OperationalMetricSummaryRow[] };
  assert.ok(Array.isArray(payload.metrics));
  const startup = payload.metrics.filter(m => m.metric_name === 'codex.memory.startup');
  // Two distinct attrs bags → two grouped rows; the succeeded bag has 2 occurrences.
  assert.equal(startup.length, 2);
  assert.equal(startup.find(m => (m.attrs as { state?: string })?.state === 'succeeded')?.occurrences, 2);
});

test('ops metrics --name-prefix filters by metric name', async () => {
  const { stdout } = await runCli(['ops', 'metrics', '--name-prefix', 'codex.memory.', '--json']);
  const payload = JSON.parse(stdout) as { metrics: OperationalMetricSummaryRow[] };
  assert.ok(payload.metrics.every(m => m.metric_name.startsWith('codex.memory.')));
  assert.ok(payload.metrics.length > 0);
});

test('ops metrics renders a table by default', async () => {
  const { stdout } = await runCli(['ops', 'metrics', '--name-prefix', 'codex.memory.']);
  assert.match(stdout, /METRIC_NAME/);
  assert.match(stdout, /state=succeeded/);
});

test('ops metrics rejects a malformed --since with a non-zero exit', async () => {
  const { exitCode, stderr } = await runCli(['ops', 'metrics', '--since', 'notadate']);
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /--since/);
});

test('ops metrics --since applies a relative window end-to-end', async () => {
  const { getDb } = await import('../src/db/connection.js');
  const db = getDb();
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace(/\..*/, '');
  const insert = db.prepare(`
    INSERT INTO otel_metrics (session_id, agent_type, metric_name, attrs, value, temporality, created_at, client_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('s3', 'codex', 'ops.window.probe', JSON.stringify({ age: 'recent' }), 1, 'delta', iso(60_000), null); // 1m ago
  insert.run('s3', 'codex', 'ops.window.probe', JSON.stringify({ age: 'stale' }), 1, 'delta', iso(2 * 86_400_000), null); // 2d ago

  const recent = await runCli(['ops', 'metrics', '--name-prefix', 'ops.window.probe', '--since', '1h', '--json']);
  const recentMetrics = (JSON.parse(recent.stdout) as { metrics: OperationalMetricSummaryRow[] }).metrics;
  assert.equal(recentMetrics.length, 1);
  assert.equal((recentMetrics[0].attrs as { age?: string }).age, 'recent');

  const wide = await runCli(['ops', 'metrics', '--name-prefix', 'ops.window.probe', '--since', '3d', '--json']);
  const wideMetrics = (JSON.parse(wide.stdout) as { metrics: OperationalMetricSummaryRow[] }).metrics;
  assert.equal(wideMetrics.length, 2);
});
