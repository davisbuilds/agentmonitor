import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActiveAgentLabel, buildCostFilters, formatMonitorCost } from '../frontend/src/lib/monitor-analytics.ts';

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
