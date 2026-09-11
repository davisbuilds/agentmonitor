import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { before } from 'node:test';

import { formatAttrs, formatOpsMetrics } from '../src/cli/formatters/ops.js';
import type { OperationalMetricSummaryRow } from '../src/db/v2-queries.js';

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
