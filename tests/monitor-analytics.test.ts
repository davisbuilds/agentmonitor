import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCostFilters, formatMonitorCost } from '../frontend/src/lib/monitor-analytics.ts';

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
