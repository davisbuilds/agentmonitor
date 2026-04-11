import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimestamp, timeAgo } from '../frontend/src/lib/format.ts';

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
  } finally {
    Date.now = originalNow;
  }
});
