import { describe, it, expect } from 'vitest';
import { mergeSessionAggregates } from './monitor-session-merge';
import type { Session } from './api/client';

function session(extra: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agent_id: 'claude_code',
    agent_type: 'claude_code',
    project: 'p',
    branch: 'main',
    status: 'active',
    started_at: '2026-09-11T00:00:00Z',
    last_event_at: '2026-09-11T00:00:00Z',
    event_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    total_cost_usd: 0,
    files_edited: 0,
    lines_added: 0,
    lines_removed: 0,
    ...extra,
  } as Session;
}

describe('mergeSessionAggregates', () => {
  it('takes the max of each numeric aggregate', () => {
    const current = session({ event_count: 10, tokens_in: 500, tokens_out: 200, total_cost_usd: 2, files_edited: 3, lines_added: 40, lines_removed: 5 });
    const incoming = session({ event_count: 4, tokens_in: 900, tokens_out: 100, total_cost_usd: 1.5, files_edited: 7, lines_added: 20, lines_removed: 12 });
    const merged = mergeSessionAggregates(current, incoming);
    expect(merged.event_count).toBe(10);
    expect(merged.tokens_in).toBe(900);
    expect(merged.tokens_out).toBe(200);
    expect(merged.total_cost_usd).toBe(2);
    expect(merged.files_edited).toBe(7);
    expect(merged.lines_added).toBe(40);
    expect(merged.lines_removed).toBe(12);
  });

  it('adopts the status of whichever side has the later last_event_at', () => {
    const current = session({ status: 'active', last_event_at: '2026-09-11T02:00:00Z' });
    const incoming = session({ status: 'ended', last_event_at: '2026-09-11T01:00:00Z' });
    expect(mergeSessionAggregates(current, incoming).status).toBe('active');

    const olderCurrent = session({ status: 'active', last_event_at: '2026-09-11T00:30:00Z' });
    const newerIncoming = session({ status: 'ended', last_event_at: '2026-09-11T03:00:00Z', ended_at: '2026-09-11T03:00:00Z' });
    expect(mergeSessionAggregates(olderCurrent, newerIncoming).status).toBe('ended');
  });

  it('keeps the earliest started_at and the latest last_event_at', () => {
    const current = session({ started_at: '2026-09-11T01:00:00Z', last_event_at: '2026-09-11T02:00:00Z' });
    const incoming = session({ started_at: '2026-09-11T00:30:00Z', last_event_at: '2026-09-11T03:00:00Z' });
    const merged = mergeSessionAggregates(current, incoming);
    expect(merged.started_at).toBe('2026-09-11T00:30:00Z');
    expect(merged.last_event_at).toBe('2026-09-11T03:00:00Z');
  });

  it('only sets ended_at when the resolved status is ended', () => {
    const stillActive = mergeSessionAggregates(
      session({ status: 'active', last_event_at: '2026-09-11T02:00:00Z' }),
      session({ status: 'ended', last_event_at: '2026-09-11T01:00:00Z', ended_at: '2026-09-11T01:00:00Z' }),
    );
    expect(stillActive.ended_at).toBeUndefined();
  });

  it('falls back to the non-empty project/branch', () => {
    const merged = mergeSessionAggregates(
      session({ project: '', branch: '' }),
      session({ project: 'real', branch: 'feature' }),
    );
    expect(merged.project).toBe('real');
    expect(merged.branch).toBe('feature');
  });
});
