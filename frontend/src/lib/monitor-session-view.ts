import type { AgentEvent, Session } from './api/client';
import { parseTimestamp } from './format';
import { mergeSessionAggregates } from './monitor-session-merge';

/** How many of a session's events its Monitor view reads and keeps. */
export const SESSION_EVENT_LIMIT = 50;

/**
 * The followed session's figures. The card's row is the one live events keep
 * current; the session's own read covers a session the cards do not list
 * (ended, or hidden by the agent filter). With both, each figure takes the
 * larger, as a card's backfill does.
 */
export function followedSessionSummary(cardRow: Session | null, detailRow: Session | null): Session | null {
  if (cardRow && detailRow) return mergeSessionAggregates(cardRow, detailRow);
  return cardRow ?? detailRow;
}

function eventTime(event: AgentEvent): number {
  const ms = parseTimestamp(event.created_at).getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** The session's recent events, newest first: its own read plus the live events since. */
export function sessionRecentEvents(
  sessionId: string,
  fetched: readonly AgentEvent[],
  live: readonly AgentEvent[],
  limit = SESSION_EVENT_LIMIT,
): AgentEvent[] {
  const byId = new Map<number, AgentEvent>();
  for (const event of [...fetched, ...live]) {
    if (event.session_id === sessionId) byId.set(event.id, event);
  }
  // Time first, as the server orders them: an imported event can carry a
  // higher id than a live one that happened after it.
  return [...byId.values()]
    .sort((a, b) => eventTime(b) - eventTime(a) || b.id - a.id)
    .slice(0, limit);
}

/** An event's label: its type, and the tool it ran. */
export function sessionEventLabel(event: AgentEvent): string {
  return event.tool_name ? `${event.event_type} › ${event.tool_name}` : event.event_type;
}

function eventMetadata(event: AgentEvent): Record<string, unknown> {
  const { metadata } = event;
  if (!metadata) return {};
  if (typeof metadata !== 'string') return metadata;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nested(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** What an event did: the prompt, command, file, pattern or error it carries. */
export function sessionEventDetail(event: AgentEvent): string | null {
  const meta = eventMetadata(event);
  if (event.event_type === 'user_prompt') {
    const prompt = text(meta.message);
    if (prompt) return prompt;
  }
  for (const key of ['content_preview', 'command', 'file_path', 'pattern', 'query', 'diff_preview', 'error']) {
    const value = text(meta[key]);
    if (value) return value;
  }
  return text(nested(meta.error, 'message')) ?? text(nested(meta.arguments, 'cmd'));
}
