import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentColor,
  agentHexColor,
  formatCost,
  formatDuration,
  formatNumber,
  formatTimeOfDay,
  parseTimestamp,
  statusColor,
  timeAgo,
} from '../frontend/src/lib/format.ts';

test('parseTimestamp treats bare SQLite timestamps as UTC', () => {
  assert.equal(parseTimestamp('2026-04-10 11:45:00').toISOString(), '2026-04-10T11:45:00.000Z');
  assert.equal(parseTimestamp('2026-04-10T11:45:00').toISOString(), '2026-04-10T11:45:00.000Z');
  assert.equal(parseTimestamp('2026-04-10T11:45:00.000Z').toISOString(), '2026-04-10T11:45:00.000Z');
});

test('timeAgo does not go negative for recent UTC-backed SQLite timestamps', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-04-10T11:45:30.000Z');
  try {
    assert.equal(timeAgo('2026-04-10 11:45:00'), '30s ago');
    assert.equal(timeAgo('2026-04-10 11:44:00'), '1m ago');
    assert.equal(timeAgo('2026-04-10 09:45:00'), '2h ago');
    assert.equal(timeAgo('2026-04-08 11:45:00'), '2d ago');
  } finally {
    Date.now = originalNow;
  }
});

test('format helpers compact numbers, costs, durations, agents, and statuses', () => {
  assert.equal(formatCost(null), '$0.00');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(1.235), '$1.24');

  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1_250), '1.3K');
  assert.equal(formatNumber(2_500_000), '2.5M');

  assert.equal(formatDuration(null), '-');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(1250), '1.3s');

  assert.equal(agentColor('claude_code'), 'text-orange-400');
  assert.equal(agentColor('codex'), 'text-gray-300');
  assert.equal(agentColor('other'), 'text-blue-400');
  assert.equal(agentHexColor('claude'), '#fb923c');
  assert.equal(agentHexColor('codex'), '#d1d5db');
  assert.equal(agentHexColor('other'), '#60a5fa');

  assert.equal(statusColor('active'), 'bg-green-400');
  assert.equal(statusColor('idle'), 'bg-yellow-400');
  assert.equal(statusColor('ended'), 'bg-gray-500');
  assert.equal(statusColor('error'), 'bg-red-400');
  assert.equal(statusColor('unknown'), 'bg-gray-500');

  assert.equal(typeof formatTimeOfDay('2026-04-10T11:45:00Z'), 'string');
});
