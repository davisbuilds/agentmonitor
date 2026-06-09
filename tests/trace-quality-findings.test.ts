import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import {
  DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS,
  TRACE_QUALITY_FINDING_KINDS,
  TRACE_QUALITY_FINDING_SEVERITIES,
} from '../src/trace-quality/constants.js';
import type { TraceQualityFinding } from '../src/api/v2/types.js';
import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';
import type { listTraceQualityFindings as listType } from '../src/trace-quality/findings.js';

let tempDir = '';
let budgetsPath = '';
let thresholdsPath = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let listTraceQualityFindings: typeof listType;

// ─── Task 1: taxonomy types, severity, evidence, default thresholds ──────────

test('finding taxonomy pins the full kind set', () => {
  assert.deepEqual([...TRACE_QUALITY_FINDING_KINDS].sort(), [
    'collector_or_otel_dropoff',
    'cost_anomaly',
    'daily_budget_risk',
    'high_error_rate',
    'high_latency_p95',
    'latency_spike',
    'low_quality_score',
    'low_trace_coverage',
    'model_error_rate',
    'observation_error',
    'rate_limit_events',
    'token_spike',
    'tool_failure_rate',
    'unknown_pricing',
  ]);
  assert.equal(TRACE_QUALITY_FINDING_KINDS.length, 14);
  assert.equal(TRACE_QUALITY_FINDING_KINDS.includes('low_score' as never), false);
  assert.equal(TRACE_QUALITY_FINDING_KINDS.includes('low_coverage' as never), false);
});

test('finding severities are ordered ascending by rank', () => {
  assert.deepEqual([...TRACE_QUALITY_FINDING_SEVERITIES], ['info', 'warning', 'high', 'critical']);
});

test('default thresholds cover every threshold-driven kind', () => {
  const d = DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS;
  assert.equal(d.high_error_rate.warning, 0.1);
  assert.equal(d.high_error_rate.min_observations, 20);
  assert.equal(d.tool_failure_rate.min_calls, 10);
  assert.equal(d.high_latency_p95.warning_ms, 30000);
  assert.equal(d.latency_spike.min_days, 2);
  assert.equal(d.cost_anomaly.min_baseline_avg_usd, 0.01);
  assert.equal(d.collector_or_otel_dropoff.warning_minutes, 60);
  assert.equal(d.low_quality_score.warning, 0.5);
  assert.equal(d.baseline_window_days, 7);
  assert.equal(d.impacted_id_cap, 50);
});

// ─── Task 2: migrated kinds (observation_error, low_quality_score, low_trace_coverage) ──

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-trace-quality-findings-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'findings.db');
  budgetsPath = path.join(tempDir, 'budgets.json');
  process.env.AGENTMONITOR_USAGE_BUDGETS_PATH = budgetsPath;
  thresholdsPath = path.join(tempDir, 'trace-quality-findings.json');
  process.env.AGENTMONITOR_TRACE_QUALITY_FINDINGS_PATH = thresholdsPath;

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const findings = await import('../src/trace-quality/findings.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  listTraceQualityFindings = findings.listTraceQualityFindings;

  initSchema();
});

beforeEach(() => {
  getDb().exec(`
    DELETE FROM trace_quality_scores;
    DELETE FROM trace_quality_observations;
    DELETE FROM trace_quality_traces;
    DELETE FROM events;
  `);
  fs.rmSync(thresholdsPath, { force: true });
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedTrace(id: string, coverage: 'high' | 'low' | null = 'high'): void {
  getDb().prepare(`
    INSERT INTO trace_quality_traces (id, session_id, agent_type, name, started_at, coverage_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `sess-${id}`,
    'codex',
    `trace ${id}`,
    '2026-06-08T10:00:00.000Z',
    coverage === null ? '{}' : JSON.stringify({ projection_confidence: coverage }),
  );
}

function seedObservation(
  id: string,
  traceId: string,
  opts: {
    status?: string | null;
    severity?: string | null;
    type?: string;
    name?: string;
    tool_name?: string | null;
    model?: string | null;
    metadata?: Record<string, unknown>;
    duration_ms?: number | null;
    started_at?: string;
    tokens_in?: number;
    tokens_out?: number;
    cache_read_tokens?: number;
    cost_usd?: number | null;
  } = {},
): void {
  getDb().prepare(`
    INSERT INTO trace_quality_observations (
      id, trace_id, session_id, source_kind, observation_type, name, status, severity,
      tool_name, model, metadata_json, duration_ms, started_at, tokens_in, tokens_out,
      cache_read_tokens, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    traceId,
    `sess-${traceId}`,
    'event',
    opts.type ?? 'generation',
    opts.name ?? `obs ${id}`,
    opts.status ?? 'success',
    opts.severity ?? null,
    opts.tool_name ?? null,
    opts.model ?? null,
    JSON.stringify(opts.metadata ?? {}),
    opts.duration_ms ?? null,
    opts.started_at ?? '2026-06-08T10:00:01.000Z',
    opts.tokens_in ?? 0,
    opts.tokens_out ?? 0,
    opts.cache_read_tokens ?? 0,
    opts.cost_usd ?? null,
  );
}

function seedManyObservations(
  traceId: string,
  total: number,
  errors: number,
  opts: { tool_name?: string; model?: string } = {},
): void {
  const batch = opts.tool_name ?? opts.model ?? 'o';
  for (let i = 0; i < total; i++) {
    seedObservation(`${traceId}-${batch}-${i}`, traceId, {
      status: i < errors ? 'error' : 'success',
      tool_name: opts.tool_name ?? null,
      model: opts.model ?? null,
    });
  }
}

function seedEvent(
  id: string,
  source: string,
  ts: string,
  opts: { cost_usd?: number; tokens_in?: number; model?: string } = {},
): void {
  getDb().prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, source, created_at, client_timestamp,
      cost_usd, tokens_in, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, `sess-${id}`, 'codex', 'tool_use', source, ts, ts,
    opts.cost_usd ?? null, opts.tokens_in ?? 0, opts.model ?? null,
  );
}

function seedTraceScore(traceId: string, numericValue: number): void {
  getDb().prepare(`
    INSERT INTO trace_quality_scores (target_type, target_id, name, value_type, numeric_value, source)
    VALUES ('trace', ?, 'correctness', 'numeric', ?, 'llm_judge')
  `).run(traceId, numericValue);
}

function findingsByKind(kind: TraceQualityFinding['kind']): TraceQualityFinding[] {
  return listTraceQualityFindings().data.filter(finding => finding.kind === kind);
}

test('observation_error: error -> high, critical severity -> critical, with inspection target', () => {
  seedTrace('t-err', 'high');
  seedObservation('o-err', 't-err', { status: 'error' });
  seedObservation('o-crit', 't-err', { status: 'success', severity: 'critical' });
  seedObservation('o-ok', 't-err', { status: 'success' });

  const found = findingsByKind('observation_error');
  assert.deepEqual(
    found.map(f => [f.observation_id, f.severity]).sort(),
    [['o-crit', 'critical'], ['o-err', 'high']],
  );
  const errFinding = found.find(f => f.observation_id === 'o-err');
  assert.deepEqual(errFinding?.evidence.next_inspection, {
    target: 'observation',
    params: { trace_id: 't-err', observation_id: 'o-err' },
  });
});

test('low_quality_score: tiers by value and respects the threshold boundary', () => {
  seedTrace('t-score', 'high');
  seedTraceScore('t-score', 0.5);  // == default threshold -> warning, included
  seedTrace('t-high-sev', 'high');
  seedTraceScore('t-high-sev', 0.25); // <= high
  seedTrace('t-crit', 'high');
  seedTraceScore('t-crit', 0.1); // <= critical
  seedTrace('t-clean', 'high');
  seedTraceScore('t-clean', 0.51); // above threshold -> excluded

  const found = findingsByKind('low_quality_score');
  assert.deepEqual(
    found.map(f => [f.trace_id, f.severity, f.evidence.metric_value]).sort(),
    [
      ['t-crit', 'critical', 0.1],
      ['t-high-sev', 'high', 0.25],
      ['t-score', 'warning', 0.5],
    ],
  );
  assert.equal(found.some(f => f.trace_id === 't-clean'), false);
});

test('low_trace_coverage: aggregate fires above ratio with >= min_traces', () => {
  for (const i of [1, 2, 3]) seedTrace(`low-${i}`, 'low');
  for (const i of [1, 2]) seedTrace(`hi-${i}`, 'high');

  const found = findingsByKind('low_trace_coverage');
  assert.equal(found.length, 1);
  const finding = found[0]!;
  assert.equal(finding.trace_id, null);
  assert.equal(finding.severity, 'high'); // 3/5 = 0.6 >= high(0.5)
  assert.equal(finding.evidence.metric_value, 0.6);
  assert.equal(finding.evidence.sample_size, 5);
  assert.equal(finding.evidence.impacted_total, 3);
  assert.deepEqual((finding.evidence.impacted_trace_ids ?? []).sort(), ['low-1', 'low-2', 'low-3']);
});

test('low_trace_coverage: suppressed below min_traces (no false positive on sparse data)', () => {
  for (const i of [1, 2, 3, 4]) seedTrace(`low-${i}`, 'low'); // 4 < min_traces(5)
  assert.equal(findingsByKind('low_trace_coverage').length, 0);
});

test('low_trace_coverage: silent when coverage is healthy', () => {
  for (const i of [1, 2, 3, 4, 5]) seedTrace(`hi-${i}`, 'high');
  assert.equal(findingsByKind('low_trace_coverage').length, 0);
});

// ─── Task 3: error-rate findings ─────────────────────────────────────────────

test('high_error_rate: fires at/above threshold with adequate sample, tiered by ratio', () => {
  seedTrace('t-er', 'high');
  seedManyObservations('t-er', 20, 5); // 5/20 = 0.25 -> high
  const found = findingsByKind('high_error_rate');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'high');
  assert.equal(found[0]!.evidence.metric_value, 0.25);
  assert.equal(found[0]!.evidence.sample_size, 20);
  assert.equal(found[0]!.evidence.impacted_total, 5);
  assert.deepEqual(found[0]!.evidence.next_inspection, { target: 'traces', params: { status: 'error' } });
});

test('high_error_rate: warning boundary at exactly 0.10', () => {
  seedTrace('t-b', 'high');
  seedManyObservations('t-b', 20, 2); // 2/20 = 0.10 -> warning
  assert.equal(findingsByKind('high_error_rate')[0]?.severity, 'warning');
});

test('high_error_rate: suppressed below min_observations (no false positive)', () => {
  seedTrace('t-small', 'high');
  seedManyObservations('t-small', 19, 19); // 100% errors but only 19 < 20
  assert.equal(findingsByKind('high_error_rate').length, 0);
});

test('tool_failure_rate: per-tool, gated by min_calls', () => {
  seedTrace('t-tool', 'high');
  seedManyObservations('t-tool', 10, 4, { tool_name: 'Bash' });  // 0.4 -> high
  seedManyObservations('t-tool', 10, 1, { tool_name: 'Read' });  // 0.1 < warning(0.2) -> none
  seedManyObservations('t-tool', 5, 5, { tool_name: 'Edit' });   // 100% but 5 < min_calls(10)

  const found = findingsByKind('tool_failure_rate');
  assert.deepEqual(found.map(f => [f.evidence.dimension?.value, f.severity]), [['Bash', 'high']]);
  assert.deepEqual(found[0]!.evidence.next_inspection, { target: 'traces', params: { tool: 'Bash' } });
});

test('model_error_rate: per-model, gated by min_calls', () => {
  seedTrace('t-model', 'high');
  seedManyObservations('t-model', 20, 5, { model: 'gpt-5' });  // 0.25 -> high
  seedManyObservations('t-model', 20, 1, { model: 'mini' });   // 0.05 < warning(0.10) -> none

  const found = findingsByKind('model_error_rate');
  assert.deepEqual(found.map(f => [f.evidence.dimension?.value, f.severity]), [['gpt-5', 'high']]);
  assert.deepEqual(found[0]!.evidence.next_inspection, { target: 'traces', params: { model: 'gpt-5' } });
});

test('rate_limit_events: counts markers in name/metadata, tiered by count', () => {
  seedTrace('t-rl', 'high');
  seedObservation('rl-1', 't-rl', { status: 'error', name: 'API error 429 Too Many Requests' });
  seedObservation('rl-2', 't-rl', { status: 'error', metadata: { error: 'rate limit exceeded' } });
  seedObservation('rl-3', 't-rl', { status: 'error', name: 'overloaded_error' });
  seedObservation('rl-4', 't-rl', { status: 'error', metadata: { message: 'Rate Limit' } });
  seedObservation('rl-5', 't-rl', { status: 'error', name: '429 rate_limit' });
  seedObservation('clean', 't-rl', { status: 'success', name: 'normal generation' });

  const found = findingsByKind('rate_limit_events');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.evidence.metric_value, 5); // >= high(5)
  assert.equal(found[0]!.severity, 'high');
  assert.equal(found[0]!.evidence.impacted_total, 5);
});

test('rate_limit_events: silent with no markers', () => {
  seedTrace('t-norl', 'high');
  seedObservation('n1', 't-norl', { status: 'error', name: 'syntax error' });
  assert.equal(findingsByKind('rate_limit_events').length, 0);
});

// ─── Task 4: latency findings ────────────────────────────────────────────────

test('high_latency_p95: fires above ms threshold with adequate samples', () => {
  seedTrace('t-lat', 'high');
  for (let i = 0; i < 20; i++) {
    seedObservation(`lat-${i}`, 't-lat', { duration_ms: 70000 }); // p95 70s -> high(60s)
  }
  const found = findingsByKind('high_latency_p95');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'high');
  assert.equal(found[0]!.evidence.metric_value, 70000);
  assert.equal(found[0]!.evidence.sample_size, 20);
});

test('high_latency_p95: suppressed below min_samples', () => {
  seedTrace('t-lat2', 'high');
  for (let i = 0; i < 19; i++) seedObservation(`l2-${i}`, 't-lat2', { duration_ms: 120000 });
  assert.equal(findingsByKind('high_latency_p95').length, 0);
});

test('latency_spike: latest-day p95 vs trailing baseline, tiered by ratio', () => {
  seedTrace('t-spike', 'high');
  // baseline day: 12 obs at 1000ms
  for (let i = 0; i < 12; i++) {
    seedObservation(`base-${i}`, 't-spike', { duration_ms: 1000, started_at: '2026-06-01T08:00:00.000Z' });
  }
  // latest day: 12 obs at 5000ms -> ratio ~5 -> high(>=3)
  for (let i = 0; i < 12; i++) {
    seedObservation(`late-${i}`, 't-spike', { duration_ms: 5000, started_at: '2026-06-08T08:00:00.000Z' });
  }
  const found = findingsByKind('latency_spike');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'high');
  assert.equal(found[0]!.evidence.metric_value, 5);
  assert.equal(found[0]!.evidence.baseline_value, 1000);
  assert.equal(found[0]!.evidence.window?.label, 'latest_day');
});

test('latency_spike: single day of data yields no false positive', () => {
  seedTrace('t-spike2', 'high');
  for (let i = 0; i < 20; i++) {
    seedObservation(`one-${i}`, 't-spike2', { duration_ms: 9000, started_at: '2026-06-08T08:00:00.000Z' });
  }
  assert.equal(findingsByKind('latency_spike').length, 0);
});

// ─── Task 5: volume-anomaly findings ─────────────────────────────────────────

const BASELINE_DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];

test('token_spike: latest-day tokens vs trailing daily average', () => {
  seedTrace('t-tok', 'high');
  BASELINE_DAYS.forEach((day, i) => {
    seedObservation(`tb-${i}`, 't-tok', { tokens_in: 50, tokens_out: 50, started_at: `${day}T08:00:00.000Z` }); // 100/day
  });
  seedObservation('tl', 't-tok', { tokens_in: 150, tokens_out: 150, started_at: '2026-06-08T08:00:00.000Z' }); // 300

  const found = findingsByKind('token_spike');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.evidence.metric_value, 3); // 300 / 100 -> warning (>=2.5, <4)
  assert.equal(found[0]!.severity, 'warning');
  assert.equal(found[0]!.evidence.baseline_value, 100);
});

test('token_spike: suppressed below min_baseline_days', () => {
  seedTrace('t-tok2', 'high');
  for (const [i, day] of ['2026-06-02', '2026-06-03'].entries()) {
    seedObservation(`t2-${i}`, 't-tok2', { tokens_in: 100, started_at: `${day}T08:00:00.000Z` });
  }
  seedObservation('t2l', 't-tok2', { tokens_in: 9000, started_at: '2026-06-08T08:00:00.000Z' }); // only 2 baseline days
  assert.equal(findingsByKind('token_spike').length, 0);
});

test('cost_anomaly: latest-day cost vs trailing daily average, critical tier', () => {
  seedTrace('t-cost', 'high');
  BASELINE_DAYS.forEach((day, i) => {
    seedObservation(`cb-${i}`, 't-cost', { cost_usd: 1.0, started_at: `${day}T08:00:00.000Z` });
  });
  seedObservation('cl', 't-cost', { cost_usd: 6.0, started_at: '2026-06-08T08:00:00.000Z' }); // 6.0/1.0 = 6 -> critical

  const found = findingsByKind('cost_anomaly');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'critical');
  assert.equal(found[0]!.evidence.metric_value, 6);
});

test('cost_anomaly: near-zero baseline avoids divide-by-zero false positive', () => {
  seedTrace('t-cost2', 'high');
  BASELINE_DAYS.forEach((day, i) => {
    seedObservation(`c2-${i}`, 't-cost2', { cost_usd: 0, started_at: `${day}T08:00:00.000Z` }); // baseline avg 0 < guard
  });
  seedObservation('c2l', 't-cost2', { cost_usd: 5.0, started_at: '2026-06-08T08:00:00.000Z' });
  assert.equal(findingsByKind('cost_anomaly').length, 0);
});

// ─── Task 6: pricing and telemetry findings ──────────────────────────────────

test('unknown_pricing: ratio of usage-bearing observations missing cost', () => {
  seedTrace('t-up', 'high');
  for (let i = 0; i < 7; i++) seedObservation(`up-ok-${i}`, 't-up', { tokens_in: 10, cost_usd: 0.01 });
  for (let i = 0; i < 3; i++) seedObservation(`up-nul-${i}`, 't-up', { tokens_in: 10, cost_usd: null, model: 'gpt-5' });

  const found = findingsByKind('unknown_pricing');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.evidence.metric_value, 0.3); // 3/10 -> high(0.30)
  assert.equal(found[0]!.severity, 'high');
  assert.equal(found[0]!.evidence.impacted_total, 3);
  assert.deepEqual(found[0]!.evidence.models, ['gpt-5']);
});

test('unknown_pricing: suppressed below min_observations', () => {
  seedTrace('t-up2', 'high');
  for (let i = 0; i < 9; i++) seedObservation(`u2-${i}`, 't-up2', { tokens_in: 10, cost_usd: null });
  assert.equal(findingsByKind('unknown_pricing').length, 0);
});

test('collector_or_otel_dropoff: fires when otel stops but activity continues', () => {
  seedEvent('otel-1', 'otel', '2026-06-08T08:00:00.000Z');
  seedEvent('otel-2', 'otel', '2026-06-08T08:30:00.000Z');
  seedEvent('api-late', 'api', '2026-06-08T10:30:00.000Z'); // 120 min after last otel

  const found = findingsByKind('collector_or_otel_dropoff');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.evidence.metric_value, 120); // >= warning(60), < high(1440)
  assert.equal(found[0]!.severity, 'warning');
  assert.equal(found[0]!.evidence.last_otel_at, '2026-06-08T08:30:00.000Z');
});

test('collector_or_otel_dropoff: silent with no otel history', () => {
  seedEvent('api-1', 'api', '2026-06-08T08:00:00.000Z');
  seedEvent('api-2', 'api', '2026-06-08T12:00:00.000Z');
  assert.equal(findingsByKind('collector_or_otel_dropoff').length, 0);
});

test('collector_or_otel_dropoff: silent when otel is the latest activity (idle, not broken)', () => {
  seedEvent('api-early', 'api', '2026-06-08T07:00:00.000Z');
  seedEvent('otel-latest', 'otel', '2026-06-08T09:00:00.000Z');
  assert.equal(findingsByKind('collector_or_otel_dropoff').length, 0);
});

// ─── Task 7: budget-risk finding ─────────────────────────────────────────────

test('daily_budget_risk: maps budget state to finding severity; absent config -> none', () => {
  // No config file -> no budget findings.
  fs.rmSync(budgetsPath, { force: true });
  assert.equal(findingsByKind('daily_budget_risk').length, 0);

  // Over-limit all_time budget -> hard_stop_candidate -> critical finding.
  fs.writeFileSync(budgetsPath, JSON.stringify({
    budgets: [{ name: 'monthly', period: 'all_time', limit_usd: 1 }],
  }));
  seedEvent('spend-1', 'api', '2026-06-08T08:00:00.000Z', { cost_usd: 0.8, tokens_in: 100, model: 'gpt-5' });
  seedEvent('spend-2', 'api', '2026-06-08T09:00:00.000Z', { cost_usd: 0.4, tokens_in: 100, model: 'gpt-5' });

  try {
    const found = findingsByKind('daily_budget_risk');
    assert.equal(found.length, 1);
    assert.equal(found[0]!.severity, 'critical'); // 1.2/1.0 = 120% -> hard_stop_candidate
    assert.equal(found[0]!.evidence.dimension?.value, 'monthly');
    assert.equal(found[0]!.evidence.spent_usd, 1.2);
    assert.deepEqual(found[0]!.evidence.next_inspection, { target: 'usage', params: {} });
  } finally {
    fs.rmSync(budgetsPath, { force: true });
  }
});

// ─── Task 8: configurable thresholds via local JSON ──────────────────────────

test('threshold override file shifts a boundary; malformed file falls back to defaults', () => {
  seedTrace('t-ov', 'high');
  seedManyObservations('t-ov', 20, 1); // 1/20 = 0.05, below default high_error_rate.warning(0.10)
  assert.equal(findingsByKind('high_error_rate').length, 0);

  // Override lowers the warning threshold so the same data now trips.
  fs.writeFileSync(thresholdsPath, JSON.stringify({ high_error_rate: { warning: 0.05 } }));
  const overridden = findingsByKind('high_error_rate');
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0]!.severity, 'warning');
  assert.equal(overridden[0]!.evidence.threshold, 0.05);

  // Malformed config degrades safely back to defaults (no crash, no finding).
  fs.writeFileSync(thresholdsPath, 'not valid json {');
  assert.equal(findingsByKind('high_error_rate').length, 0);
});

// ─── Task 9: integration sweep, ordering, pagination ─────────────────────────

const D = ['2026-06-01', '2026-06-02', '2026-06-03'];
const DL = '2026-06-08';

function seedAllKinds(): void {
  // 6 traces: 3 healthy, 3 low-coverage (ratio 0.5 -> low_trace_coverage)
  seedTrace('t-main', 'high');
  seedTrace('t-base', 'high');
  seedTrace('t-latest', 'high');
  seedTrace('t-low1', 'low');
  seedTrace('t-low2', 'low');
  seedTrace('t-low3', 'low');

  seedTraceScore('t-low1', 0.2); // low_quality_score (high tier)

  // Baseline days: latency/token/cost baselines.
  for (const day of D) {
    for (let i = 0; i < 5; i++) {
      seedObservation(`b-${day}-${i}`, 't-base', {
        duration_ms: 1000, tokens_in: 20, cost_usd: 0.2, started_at: `${day}T08:00:00.000Z`,
      });
    }
  }
  // Latest day: latency spike + high p95 + token spike + cost anomaly.
  for (let i = 0; i < 20; i++) {
    seedObservation(`l-${i}`, 't-latest', {
      duration_ms: 40000, tokens_in: 50, cost_usd: 0.5, started_at: `${DL}T08:00:00.000Z`,
    });
  }
  // unknown_pricing: usage-bearing observations with no cost.
  for (let i = 0; i < 20; i++) {
    seedObservation(`up-${i}`, 't-main', { tokens_in: 10, cost_usd: null, model: 'gpt-5', started_at: `${DL}T09:00:00.000Z` });
  }
  // tool_failure_rate + model_error_rate (also feed high_error_rate + observation_error).
  seedManyObservations('t-main', 10, 4, { tool_name: 'Bash' });
  seedManyObservations('t-main', 20, 5, { model: 'gpt-5' });
  // rate_limit_events.
  for (let i = 0; i < 5; i++) {
    seedObservation(`rl-${i}`, 't-main', { status: 'error', name: '429 rate limit', cost_usd: 0.01 });
  }

  // OTEL drop-off: otel events, then later non-otel activity.
  seedEvent('ot1', 'otel', '2026-06-08T05:00:00.000Z');
  seedEvent('ot2', 'otel', '2026-06-08T05:30:00.000Z');
  seedEvent('sp1', 'api', '2026-06-08T09:00:00.000Z', { cost_usd: 1.2, tokens_in: 100, model: 'gpt-5' });

  // daily_budget_risk.
  fs.writeFileSync(budgetsPath, JSON.stringify({ budgets: [{ name: 'cap', period: 'all_time', limit_usd: 1 }] }));
}

function sevRank(severity: string): number {
  const i = (TRACE_QUALITY_FINDING_SEVERITIES as readonly string[]).indexOf(severity);
  return TRACE_QUALITY_FINDING_SEVERITIES.length - 1 - i;
}
function kindRank(kind: string): number {
  return (TRACE_QUALITY_FINDING_KINDS as readonly string[]).indexOf(kind);
}

test('integration: every finding kind fires, output is sorted, pagination is stable', () => {
  try {
    seedAllKinds();
    const all = listTraceQualityFindings({ limit: 500 });

    // Every taxonomy kind is represented.
    const present = new Set(all.data.map(f => f.kind));
    assert.deepEqual([...present].sort(), [...TRACE_QUALITY_FINDING_KINDS].sort());

    // Sorted by severity (most severe first), then declared kind order.
    for (let i = 1; i < all.data.length; i++) {
      const prev = all.data[i - 1]!;
      const curr = all.data[i]!;
      const order = sevRank(prev.severity) - sevRank(curr.severity)
        || kindRank(prev.kind) - kindRank(curr.kind);
      assert.ok(order <= 0, `ordering violated at ${i}: ${prev.kind}/${prev.severity} before ${curr.kind}/${curr.severity}`);
    }

    // Pagination slices the same sorted list deterministically.
    const page1 = listTraceQualityFindings({ limit: 5, offset: 0 });
    const page2 = listTraceQualityFindings({ limit: 5, offset: 5 });
    assert.equal(page1.total, all.total);
    assert.equal(page2.total, all.total);
    assert.deepEqual(
      [...page1.data, ...page2.data].map(f => f.id),
      all.data.slice(0, 10).map(f => f.id),
    );
  } finally {
    fs.rmSync(budgetsPath, { force: true });
  }
});

test('integration: empty database produces no findings (no false positives)', () => {
  assert.equal(listTraceQualityFindings().total, 0);
});

// ─── PR review fixes ─────────────────────────────────────────────────────────

test('error rates count severity error/critical even when status is not failing', () => {
  seedTrace('t-sev', 'high');
  for (let i = 0; i < 15; i++) seedObservation(`sev-ok-${i}`, 't-sev', { status: 'success' });
  for (let i = 0; i < 5; i++) seedObservation(`sev-crit-${i}`, 't-sev', { status: 'success', severity: 'critical' });

  const found = findingsByKind('high_error_rate');
  assert.equal(found.length, 1); // 5/20 = 0.25 via severity, despite non-error status
  assert.equal(found[0]!.severity, 'high');
  assert.equal(found[0]!.evidence.metric_value, 0.25);
});

test('collector_or_otel_dropoff respects a date-only date_to as the whole day', () => {
  seedEvent('ot-a', 'otel', '2026-06-08T05:00:00.000Z');
  seedEvent('ot-b', 'otel', '2026-06-08T05:30:00.000Z');
  seedEvent('api-c', 'api', '2026-06-08T07:30:00.000Z'); // 120 min after last otel, same day

  const filtered = listTraceQualityFindings({ date_to: '2026-06-08' })
    .data.filter(f => f.kind === 'collector_or_otel_dropoff');
  assert.equal(filtered.length, 1); // not excluded by the inclusive end-of-day boundary
  assert.equal(filtered[0]!.evidence.metric_value, 120);
});

test('unknown_pricing counts cache-token-only observations as usage-bearing', () => {
  seedTrace('t-cache', 'high');
  // Non-generation observations whose only usage is cache reads, with no resolved cost.
  for (let i = 0; i < 10; i++) {
    seedObservation(`cache-${i}`, 't-cache', { type: 'span', cache_read_tokens: 100, cost_usd: null });
  }
  const found = findingsByKind('unknown_pricing');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.evidence.sample_size, 10);
  assert.equal(found[0]!.evidence.impacted_total, 10);
});

test('unknown_pricing ignores zero-token generations (no billable usage to price)', () => {
  seedTrace('t-zerogen', 'high');
  // Generations with no token usage and no cost can never be priced, so they must
  // not inflate the unknown-pricing ratio (they are not genuinely "unknown pricing").
  for (let i = 0; i < 20; i++) {
    seedObservation(`zg-${i}`, 't-zerogen', { type: 'generation', tokens_in: 0, tokens_out: 0, cost_usd: null });
  }
  assert.equal(findingsByKind('unknown_pricing').length, 0);
});
