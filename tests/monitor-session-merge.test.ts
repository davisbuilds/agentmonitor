import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '../frontend/src/lib/api/client.ts';
import { mergeSessionAggregates } from '../frontend/src/lib/monitor-session-merge.ts';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'sess-1',
    agent_id: 'claude_code',
    agent_type: 'claude_code',
    status: 'active',
    started_at: '2026-04-10 10:00:00',
    last_event_at: '2026-04-10 10:00:00',
    event_count: 1,
    tokens_in: 0,
    tokens_out: 0,
    total_cost_usd: 0,
    files_edited: 0,
    lines_added: 0,
    lines_removed: 0,
    ...overrides,
  };
}

test('mergeSessionAggregates preserves terminal status from newer live state over stale backfill', () => {
  const current = makeSession({
    status: 'ended',
    last_event_at: '2026-04-10 10:05:00',
    ended_at: '2026-04-10 10:05:00',
    event_count: 4,
  });
  const incoming = makeSession({
    status: 'active',
    last_event_at: '2026-04-10 10:00:00',
    ended_at: undefined,
    event_count: 6,
  });

  const merged = mergeSessionAggregates(current, incoming);

  assert.equal(merged.status, 'ended');
  assert.equal(merged.ended_at, '2026-04-10 10:05:00');
  assert.equal(merged.last_event_at, '2026-04-10 10:05:00');
  assert.equal(merged.event_count, 6);
});

test('mergeSessionAggregates clears stale ended_at when newer state is active', () => {
  const current = makeSession({
    status: 'active',
    last_event_at: '2026-04-10 10:05:00',
  });
  const incoming = makeSession({
    status: 'ended',
    last_event_at: '2026-04-10 10:00:00',
    ended_at: '2026-04-10 10:00:00',
  });

  const merged = mergeSessionAggregates(current, incoming);

  assert.equal(merged.status, 'active');
  assert.equal(merged.ended_at, undefined);
  assert.equal(merged.last_event_at, '2026-04-10 10:05:00');
});
