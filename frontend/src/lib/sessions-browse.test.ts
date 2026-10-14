import { describe, it, expect } from 'vitest';
import type { PinnedMessage } from './api/client';
import { filterPinnedMessages, pinnedMessagePreview, sessionsListMode, startsSearch } from './sessions-browse';

function pin(overrides: Partial<PinnedMessage>): PinnedMessage {
  return {
    id: 1,
    session_id: 's1',
    message_id: 10,
    message_ordinal: 3,
    role: 'user',
    content: JSON.stringify([{ type: 'text', text: 'Fix the quota reset bug' }]),
    message_timestamp: null,
    created_at: '2026-10-01T10:00:00.000Z',
    session_project: 'agentmonitor',
    session_agent: 'claude',
    session_first_message: 'Audit the parser',
    session_title: 'Parser audit',
    ...overrides,
  };
}

describe('sessionsListMode', () => {
  it('shows the session list with no query and Pinned off', () => {
    expect(sessionsListMode({ query: '', pinned: false })).toBe('list');
    expect(sessionsListMode({ query: '   ', pinned: false })).toBe('list');
  });

  it('shows full-text results while a query is entered', () => {
    expect(sessionsListMode({ query: 'quota', pinned: false })).toBe('search');
  });

  it('shows pinned messages while Pinned is on, with or without a query', () => {
    expect(sessionsListMode({ query: '', pinned: true })).toBe('pinned');
    expect(sessionsListMode({ query: 'quota', pinned: true })).toBe('pinned');
  });
});

describe('startsSearch', () => {
  it('is true only when a query appears where there was none', () => {
    expect(startsSearch('', 'q')).toBe(true);
    expect(startsSearch('  ', 'q')).toBe(true);
    expect(startsSearch('q', 'qu')).toBe(false);
    expect(startsSearch('q', '')).toBe(false);
    expect(startsSearch('', ' ')).toBe(false);
  });
});

describe('filterPinnedMessages', () => {
  const pins = [
    pin({ id: 1, session_project: 'agentmonitor', session_agent: 'claude' }),
    pin({
      id: 2,
      session_project: 'blueprint',
      session_agent: 'codex',
      content: JSON.stringify([{ type: 'text', text: 'Rename the importer' }]),
      session_title: 'Importer cleanup',
    }),
    pin({ id: 3, session_project: null, session_agent: 'codex', content: null, session_title: 'Quota dashboard' }),
  ];
  const none = { project: '', agent: '', query: '' };
  const ids = (list: PinnedMessage[]) => list.map((p) => p.id);

  it('keeps every pin when no filter is set', () => {
    expect(ids(filterPinnedMessages(pins, none))).toEqual([1, 2, 3]);
  });

  it('filters by project and agent', () => {
    expect(ids(filterPinnedMessages(pins, { ...none, project: 'blueprint' }))).toEqual([2]);
    expect(ids(filterPinnedMessages(pins, { ...none, agent: 'codex' }))).toEqual([2, 3]);
    expect(ids(filterPinnedMessages(pins, { ...none, project: 'agentmonitor', agent: 'codex' }))).toEqual([]);
  });

  it('narrows by the words a pin shows, ignoring case and surrounding spaces', () => {
    expect(ids(filterPinnedMessages(pins, { ...none, query: '  QUOTA ' }))).toEqual([1, 3]);
    // The session title matches too, not only the message preview.
    expect(ids(filterPinnedMessages(pins, { ...none, query: 'importer cleanup' }))).toEqual([2]);
    expect(ids(filterPinnedMessages(pins, { ...none, query: 'quota', agent: 'codex' }))).toEqual([3]);
    expect(ids(filterPinnedMessages(pins, { ...none, query: 'nothing like this' }))).toEqual([]);
  });

  it('does not match the JSON structure around the message text', () => {
    expect(ids(filterPinnedMessages(pins, { ...none, query: 'type' }))).toEqual([]);
  });
});

describe('pinnedMessagePreview', () => {
  it('shows the message text, else the session title', () => {
    expect(pinnedMessagePreview(pin({}))).toBe('Fix the quota reset bug');
    expect(pinnedMessagePreview(pin({ content: null }))).toBe('Parser audit');
  });
});
