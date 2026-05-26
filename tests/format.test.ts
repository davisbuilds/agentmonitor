import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentColor,
  agentDisplayName,
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
  assert.equal(formatNumber(999_900_000), '999.9M');
  assert.equal(formatNumber(1_000_000_000), '1.0B');
  assert.equal(formatNumber(2_049_100_000), '2.0B');

  assert.equal(formatDuration(null), '-');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(1250), '1.3s');

  assert.equal(agentColor('claude_code'), 'text-claude');
  assert.equal(agentColor('codex'), 'text-codex');
  assert.equal(agentColor('other'), 'text-accent');
  assert.equal(agentHexColor('claude'), 'var(--color-claude)');
  assert.equal(agentHexColor('codex'), 'var(--color-codex)');
  assert.equal(agentHexColor('other'), 'var(--color-accent)');

  assert.equal(agentDisplayName('claude'), 'Claude');
  assert.equal(agentDisplayName('claude_code'), 'Claude');
  assert.equal(agentDisplayName('codex'), 'Codex');
  assert.equal(agentDisplayName('other'), 'Assistant');

  assert.equal(statusColor('active'), 'bg-ok');
  assert.equal(statusColor('idle'), 'bg-warn');
  assert.equal(statusColor('ended'), 'bg-line-strong');
  assert.equal(statusColor('error'), 'bg-danger');
  assert.equal(statusColor('unknown'), 'bg-line-strong');

  assert.equal(typeof formatTimeOfDay('2026-04-10T11:45:00Z'), 'string');
});
