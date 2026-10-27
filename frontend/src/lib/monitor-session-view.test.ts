import { describe, it, expect } from 'vitest';
import type { AgentEvent, Session } from './api/client';
import {
  followedSessionSummary,
  sessionEventDetail,
  sessionEventLabel,
  sessionRecentEvents,
} from './monitor-session-view';

function session(extra: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agent_id: 'claude_code',
    agent_type: 'claude_code',
    status: 'active',
    started_at: '2026-10-26T10:00:00Z',
    last_event_at: '2026-10-26T10:00:00Z',
    event_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    total_cost_usd: 0,
    ...extra,
  };
}

let nextId = 1;
function event(extra: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: nextId++,
    session_id: 's1',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    status: 'success',
    tokens_in: 0,
    tokens_out: 0,
    created_at: '2026-10-26T10:00:00Z',
    ...extra,
  };
}

describe('followedSessionSummary', () => {
  it('is nothing until either row is known', () => {
    expect(followedSessionSummary(null, null)).toBeNull();
  });

  it('uses whichever row is known', () => {
    const card = session({ total_cost_usd: 2 });
    const detail = session({ total_cost_usd: 3 });
    expect(followedSessionSummary(card, null)).toBe(card);
    expect(followedSessionSummary(null, detail)).toBe(detail);
  });

  it('takes the larger figure from each row when both are known', () => {
    // The card has counted live events since the read; the read has an import the card missed.
    const card = session({ event_count: 12, tokens_in: 900, total_cost_usd: 1.5, last_event_at: '2026-10-26T10:05:00Z' });
    const detail = session({ event_count: 10, tokens_in: 1200, total_cost_usd: 1.2, mode: 'headless' });
    const merged = followedSessionSummary(card, detail);
    expect(merged).toMatchObject({ event_count: 12, tokens_in: 1200, total_cost_usd: 1.5, mode: 'headless' });
    expect(merged?.last_event_at).toBe('2026-10-26T10:05:00Z');
  });
});

describe('sessionRecentEvents', () => {
  it('lists the session\'s events newest first, once each, without other sessions\' events', () => {
    const older = event({ created_at: '2026-10-26T10:00:00Z' });
    const newer = event({ created_at: '2026-10-26T10:02:00Z' });
    const live = event({ created_at: '2026-10-26T10:03:00Z' });
    const otherSession = event({ session_id: 's2', created_at: '2026-10-26T10:04:00Z' });
    const ids = sessionRecentEvents('s1', [newer, older], [live, otherSession, newer]).map(e => e.id);
    expect(ids).toEqual([live.id, newer.id, older.id]);
  });

  it('orders by time before id, so an imported event lands where it happened', () => {
    const live = event({ created_at: '2026-10-26T10:05:00Z' });
    const imported = event({ created_at: '2026-10-26T10:01:00Z' });
    expect(sessionRecentEvents('s1', [imported], [live]).map(e => e.id)).toEqual([live.id, imported.id]);
  });

  it('breaks a tie in time by the newer id', () => {
    const first = event({ created_at: '2026-10-26T10:00:00Z' });
    const second = event({ created_at: '2026-10-26T10:00:00Z' });
    expect(sessionRecentEvents('s1', [first, second], []).map(e => e.id)).toEqual([second.id, first.id]);
  });

  it('keeps the newest up to the limit', () => {
    const events = Array.from({ length: 5 }, (_, n) => event({ created_at: `2026-10-26T10:0${n}:00Z` }));
    expect(sessionRecentEvents('s1', events, [], 2).map(e => e.id)).toEqual([events[4].id, events[3].id]);
  });
});

describe('sessionEventLabel', () => {
  it('names the tool after the event type', () => {
    expect(sessionEventLabel(event({ event_type: 'tool_use', tool_name: 'Bash' }))).toBe('tool_use › Bash');
    expect(sessionEventLabel(event({ event_type: 'session_start' }))).toBe('session_start');
  });
});

describe('sessionEventDetail', () => {
  it('reads what the event did from its metadata, string or parsed', () => {
    expect(sessionEventDetail(event({ metadata: { command: 'pnpm test' } }))).toBe('pnpm test');
    expect(sessionEventDetail(event({ metadata: JSON.stringify({ file_path: 'src/app.ts' }) }))).toBe('src/app.ts');
    expect(sessionEventDetail(event({ metadata: { arguments: { cmd: 'ls -la' } } }))).toBe('ls -la');
  });

  it('shows a prompt only on the prompt event', () => {
    expect(sessionEventDetail(event({ event_type: 'user_prompt', metadata: { message: 'fix the bug' } }))).toBe('fix the bug');
    expect(sessionEventDetail(event({ event_type: 'tool_use', metadata: { message: 'internal note' } }))).toBeNull();
  });

  it('reads an error string or an error object\'s message', () => {
    expect(sessionEventDetail(event({ event_type: 'error', metadata: { error: 'rate limited' } }))).toBe('rate limited');
    expect(sessionEventDetail(event({ event_type: 'error', metadata: { error: { message: 'boom' } } }))).toBe('boom');
  });

  it('is nothing for empty or unreadable metadata', () => {
    expect(sessionEventDetail(event({ metadata: undefined }))).toBeNull();
    expect(sessionEventDetail(event({ metadata: '{not json' }))).toBeNull();
    expect(sessionEventDetail(event({ metadata: { command: '   ' } }))).toBeNull();
  });
});
