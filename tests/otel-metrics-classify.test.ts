import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { parseOtelMetrics, resetCumulativeState } from '../src/otel/parser.ts';

// parseOtelMetrics classifies each metric datapoint into one of:
//   usage       — Claude Code token/cost (→ synthetic llm_response, unchanged)
//   operational — Bucket A outcome/state counters (→ otel_metrics table)
//   (skipped)   — Codex token/cost metrics: recognized, deliberately NOT stored
//                 (logs are authoritative; storing would double-count)
//   dropped     — timings/sizes/unrecognized: tallied by name for intake visibility
//
// Fixture names are taken verbatim from the Codex 0.153.2 binary's metric registry.

type Point = { value: number; attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number } }> };

function attr(key: string, str: string) {
  return { key, value: { stringValue: str } };
}

function metricsPayload(
  service: string,
  sessionId: string,
  metrics: Array<{ name: string; cumulative?: boolean; gauge?: boolean; startNano?: string; points: Point[] }>,
) {
  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: service } },
          { key: 'gen_ai.session.id', value: { stringValue: sessionId } },
        ],
      },
      scopeMetrics: [{
        metrics: metrics.map(m => {
          const dataPoints = m.points.map(p => ({
            asInt: String(p.value),
            attributes: p.attributes ?? [],
            timeUnixNano: '1756900000000000000',
            startTimeUnixNano: m.startNano ?? '1756000000000000000',
          }));
          return m.gauge
            ? { name: m.name, gauge: { dataPoints } }
            : { name: m.name, sum: { dataPoints, isMonotonic: true, aggregationTemporality: m.cumulative ? 2 : 1 } };
        }),
      }],
    }],
  };
}

beforeEach(() => resetCumulativeState());

describe('parseOtelMetrics classification', () => {
  test('an allowlisted Codex counter is captured, with attrs projected to outcomes only', () => {
    // Live Codex emits codex.memory.startup with a pile of descriptive labels
    // (app.version/auth_mode/model/originator/session_source) that fragment the
    // series. Only the outcome attribute is kept, so the metric collapses to the
    // one series that answers "did startup skip, and why".
    const result = parseOtelMetrics(metricsPayload('codex', 'sess-op', [
      { name: 'codex.memory.startup', points: [{ value: 1, attributes: [
        attr('state', 'skipped_rate_limit'),
        attr('app.version', '0.153.2'),
        attr('auth_mode', 'Chatgpt'),
        attr('model', 'gpt-5.6-luna'),
        attr('originator', 'codex-tui'),
        attr('session_source', 'cli'),
      ] }] },
    ]));
    assert.equal(result.operational.length, 1);
    const m = result.operational[0];
    assert.equal(m.metric_name, 'codex.memory.startup');
    assert.equal(m.session_id, 'sess-op');
    assert.deepEqual(m.attrs, { state: 'skipped_rate_limit' }); // descriptive labels stripped
    assert.equal(m.value, 1);
    assert.equal(result.usage.length, 0);
  });

  test('an error/fallback name-signal metric is admitted even outside the memory prefix', () => {
    const result = parseOtelMetrics(metricsPayload('codex', 'sess-e', [
      { name: 'codex.db.error', points: [{ value: 1, attributes: [attr('reason', 'locked')] }] },
      { name: 'codex.sqlite.fallback.count', points: [{ value: 1, attributes: [attr('status', 'failed')] }] },
    ]));
    assert.deepEqual(result.operational.map(m => m.metric_name).sort(), ['codex.db.error', 'codex.sqlite.fallback.count']);
  });

  test('high-cardinality internal counters are dropped, not stored', () => {
    // shadow_selection (internal skill-routing A/B eval) and sqlite plumbing both
    // carry a `status`/`outcome` attr but are not operator-actionable — the exact
    // noise that would bloat the store. Not in the allowlist → dropped (tallied).
    const result = parseOtelMetrics(metricsPayload('codex', 'sess-n', [
      { name: 'codex.skills.shadow_selection', points: [{ value: 1, attributes: [attr('method', 'bm25_v1'), attr('status', 'selected')] }] },
      { name: 'codex.sqlite.init.count', points: [{ value: 1, attributes: [attr('status', 'success')] }] },
      { name: 'codex.skill.injected', points: [{ value: 1, attributes: [attr('status', 'ok'), attr('skill', 'deep-research')] }] },
    ]));
    assert.equal(result.operational.length, 0);
    assert.equal(result.dropped['codex.skills.shadow_selection'], 1);
    assert.equal(result.dropped['codex.sqlite.init.count'], 1);
    assert.equal(result.dropped['codex.skill.injected'], 1);
  });

  test('a *.duration_ms timing is dropped (tallied), never operational', () => {
    const result = parseOtelMetrics(metricsPayload('codex', 'sess-t', [
      { name: 'codex.api_request.duration_ms', points: [{ value: 42, attributes: [attr('status', 'ok')] }] },
    ]));
    assert.equal(result.operational.length, 0);
    assert.equal(result.dropped['codex.api_request.duration_ms'], 1);
  });

  test('a size gauge with no outcome attribute is dropped, not stored', () => {
    const result = parseOtelMetrics(metricsPayload('codex', 'sess-b', [
      { name: 'codex.rollout.size_bytes', gauge: true, points: [{ value: 999 }] },
    ]));
    assert.equal(result.operational.length, 0);
    assert.equal(result.dropped['codex.rollout.size_bytes'], 1);
  });

  test('Codex token/cost metrics are recognized and skipped — not operational, not dropped', () => {
    // Logs own Codex token/cost; storing these would double-count. They must NOT
    // pollute the dropped/intake-visibility tally either (they are handled, not unknown).
    const result = parseOtelMetrics(metricsPayload('codex', 'sess-tok', [
      { name: 'codex.turn.token_usage.input_tokens', points: [{ value: 5000 }] },
      { name: 'codex.turn.cost_microusd', points: [{ value: 1200 }] },
      { name: 'codex.usage.total_tokens', points: [{ value: 5300 }] },
    ]));
    assert.equal(result.operational.length, 0);
    assert.equal(result.usage.length, 0);
    assert.deepEqual(result.dropped, {});
  });

  test('Claude Code token usage still flows to usage deltas (unchanged)', () => {
    const result = parseOtelMetrics(metricsPayload('claude_code', 'sess-cc', [
      { name: 'claude_code.token.usage', points: [
        { value: 1000, attributes: [attr('type', 'input'), attr('model', 'claude-sonnet-5')] },
        { value: 250, attributes: [attr('type', 'output'), attr('model', 'claude-sonnet-5')] },
      ] },
    ]));
    assert.equal(result.usage.length, 2);
    assert.equal(result.usage.find(u => u.tokens_in_delta > 0)!.tokens_in_delta, 1000);
    assert.equal(result.usage.find(u => u.tokens_out_delta > 0)!.tokens_out_delta, 250);
    assert.equal(result.operational.length, 0);
  });

  test('cumulative operational counters convert to per-export deltas keyed by attrs', () => {
    const first = parseOtelMetrics(metricsPayload('codex', 'sess-c', [
      { name: 'codex.memory.phase1', cumulative: true, points: [{ value: 1, attributes: [attr('state', 'succeeded')] }] },
    ]));
    assert.equal(first.operational[0].value, 1); // first sighting = current value
    const second = parseOtelMetrics(metricsPayload('codex', 'sess-c', [
      { name: 'codex.memory.phase1', cumulative: true, points: [{ value: 3, attributes: [attr('state', 'succeeded')] }] },
    ]));
    assert.equal(second.operational[0].value, 2); // 3 - 1
    assert.equal(second.operational[0].temporality, 'delta');
  });

  test('a cumulative producer restart (new startTimeUnixNano) re-emits the current value', () => {
    // Sessionless/process-level Codex counters reuse their derived key across
    // process restarts. Without folding in startTimeUnixNano, a repeated
    // cumulative `=1` after restart diffs against the previous process's stored 1
    // → delta 0 → silently swallowed, hiding every later startup outcome.
    const opts = { name: 'codex.memory.startup', cumulative: true, points: [{ value: 1, attributes: [attr('state', 'skipped_rate_limit')] }] };
    const p1 = parseOtelMetrics(metricsPayload('codex', 'unknown', [{ ...opts, startNano: '100' }]));
    assert.equal(p1.operational[0].value, 1); // process 1, first sighting

    const p1again = parseOtelMetrics(metricsPayload('codex', 'unknown', [{ ...opts, startNano: '100' }]));
    assert.equal(p1again.operational.length, 0); // same series, unchanged cumulative → no delta

    const p2 = parseOtelMetrics(metricsPayload('codex', 'unknown', [{ ...opts, startNano: '200' }]));
    assert.equal(p2.operational.length, 1); // restart → fresh series
    assert.equal(p2.operational[0].value, 1); // the new process's startup is recorded, not swallowed
  });

  test('distinct outcome states are tracked as separate cumulative series', () => {
    parseOtelMetrics(metricsPayload('codex', 'sess-d', [
      { name: 'codex.memory.startup', cumulative: true, points: [
        { value: 2, attributes: [attr('state', 'skipped_rate_limit')] },
        { value: 5, attributes: [attr('state', 'succeeded')] },
      ] },
    ]));
    const next = parseOtelMetrics(metricsPayload('codex', 'sess-d', [
      { name: 'codex.memory.startup', cumulative: true, points: [
        { value: 4, attributes: [attr('state', 'skipped_rate_limit')] }, // +2
        { value: 5, attributes: [attr('state', 'succeeded')] },          // +0 → dropped (no change)
      ] },
    ]));
    const skips = next.operational.filter(m => (m.attrs as { state: string }).state === 'skipped_rate_limit');
    assert.equal(skips.length, 1);
    assert.equal(skips[0].value, 2);
    // The unchanged 'succeeded' series produced no positive delta → not emitted.
    assert.equal(next.operational.some(m => (m.attrs as { state: string }).state === 'succeeded'), false);
  });
});
