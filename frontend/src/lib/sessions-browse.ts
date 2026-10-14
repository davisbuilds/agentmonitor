import type { PinnedMessage } from './api/client';
import type { SessionsRouteState } from './route-state';
import { getMessagePreviewText, sessionTitle } from './session-text';

/**
 * What the Sessions list area shows: the session list, full-text message
 * results while a query is entered, or pinned messages while the Pinned filter
 * is on (a query then narrows the pins rather than searching every transcript).
 */
export type SessionsListMode = 'list' | 'search' | 'pinned';

export function sessionsListMode(state: Pick<SessionsRouteState, 'query' | 'pinned'>): SessionsListMode {
  if (state.pinned) return 'pinned';
  return state.query.trim() ? 'search' : 'list';
}

/**
 * Whether a query edit starts a search. Starting one adds a history entry, so
 * Back returns to the list; later keystrokes replace it rather than leaving one
 * entry per character.
 */
export function startsSearch(previousQuery: string, nextQuery: string): boolean {
  return !previousQuery.trim() && !!nextQuery.trim();
}

/** The words a pinned message shows in the list: its text, else its session's title. */
export function pinnedMessagePreview(pin: PinnedMessage): string {
  return getMessagePreviewText({ content: pin.content ?? '' })
    || sessionTitle({ title: pin.session_title, first_message: pin.session_first_message, agent: pin.session_agent });
}

export interface PinnedMessageFilter {
  project: string;
  agent: string;
  query: string;
}

/**
 * The pinned messages the Sessions filters select. Pins are few and loaded in
 * full, so project, agent and query all filter here; the query matches the
 * words each pin shows (its preview and its session's title), case-insensitively.
 */
export function filterPinnedMessages(pins: PinnedMessage[], filter: PinnedMessageFilter): PinnedMessage[] {
  const needle = filter.query.trim().toLowerCase();
  return pins.filter((pin) => {
    if (filter.project && pin.session_project !== filter.project) return false;
    if (filter.agent && pin.session_agent !== filter.agent) return false;
    if (!needle) return true;
    const title = sessionTitle({ title: pin.session_title, first_message: pin.session_first_message, agent: pin.session_agent });
    return `${pinnedMessagePreview(pin)}\n${title}`.toLowerCase().includes(needle);
  });
}
