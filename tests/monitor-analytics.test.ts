import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveAgentLabel,
  buildCostFilters,
  formatMonitorCost,
  shortModelName,
} from '../frontend/src/lib/monitor-analytics.ts';

test('buildCostFilters applies rolling since window when no explicit since exists', () => {
  const filters = buildCostFilters({ project: 'agentmonitor' }, '60d', new Date('2026-04-10T12:00:00.000Z'));

  assert.equal(filters.project, 'agentmonitor');
  assert.equal(filters.since, '2026-02-09T12:00:00.000Z');
});

test('buildCostFilters preserves explicit since and all-time selection', () => {
  assert.deepEqual(
    buildCostFilters({ since: '2026-01-01T00:00:00.000Z' }, '30d', new Date('2026-04-10T12:00:00.000Z')),
    { since: '2026-01-01T00:00:00.000Z' },
  );

  assert.deepEqual(
    buildCostFilters({ agent_type: 'codex' }, 'all', new Date('2026-04-10T12:00:00.000Z')),
    { agent_type: 'codex' },
  );

  assert.deepEqual(
    buildCostFilters({ project: 'agentmonitor' }, 'all', new Date('2026-04-10T12:00:00.000Z')),
    { project: 'agentmonitor' },
  );
});

test('formatMonitorCost preserves operator-friendly small values', () => {
  assert.equal(formatMonitorCost(0), '$0.00');
  assert.equal(formatMonitorCost(0.004), '<$0.01');
  assert.equal(formatMonitorCost(0.1234), '$0.123');
  assert.equal(formatMonitorCost(1.234), '$1.23');
});

test('buildActiveAgentLabel includes model and reasoning effort when available', () => {
  assert.equal(
    buildActiveAgentLabel('codex', [
      { metadata: { reasoning_effort: 'high' } },
      { model: 'openai/gpt-5.5' },
    ]),
    'codex (gpt-5.5 high)',
  );
});

test('buildActiveAgentLabel omits unavailable model metadata', () => {
  assert.equal(buildActiveAgentLabel('claude_code', []), 'claude_code');
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: 'gpt-5.4', metadata: '{bad json' }]),
    'codex (gpt-5.4)',
  );
});

test('buildActiveAgentLabel skips the <synthetic> marker and falls through to the real model', () => {
  // Events are newest-first; a synthetic rate-limit/error turn (model "<synthetic>",
  // written by Claude Code itself) must not overwrite the last real model.
  assert.equal(
    buildActiveAgentLabel('claude_code', [
      { model: '<synthetic>' },
      { model: 'anthropic/claude-opus-4-7' },
    ]),
    'claude_code (claude-opus-4-7)',
  );
});

test('buildActiveAgentLabel drops the suffix when the only model is <synthetic>', () => {
  assert.equal(
    buildActiveAgentLabel('claude_code', [{ model: '<synthetic>' }]),
    'claude_code',
  );
});

test('shortModelName compacts known provider model families', () => {
  assert.equal(shortModelName(''), 'unknown');
  assert.equal(shortModelName('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModelName('claude-opus-4-7'), 'opus-4.7');
  assert.equal(shortModelName('claude-opus-4-6-20260101'), 'opus-4.6');
  assert.equal(shortModelName('claude-opus-4-5-20260101'), 'opus-4.5');
  assert.equal(shortModelName('claude-haiku-4-5-20260101'), 'haiku-4.5');
  assert.equal(shortModelName('claude-3-5-sonnet-20241022'), 'sonnet-3.5');
  assert.equal(shortModelName('claude-3-5-haiku-20241022'), 'haiku-3.5');
  assert.equal(shortModelName('claude-3-opus-20240229'), 'opus-3');
  assert.equal(shortModelName('claude-custom'), 'c-custom');
  assert.equal(shortModelName('gpt-5.5'), 'gpt-5.5');
});
