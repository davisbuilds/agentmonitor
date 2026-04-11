import type { Session } from './api/client';
import { parseTimestamp } from './format';

function timestampMs(value?: string): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = parseTimestamp(value).getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function pickLatestTimestamp(current?: string, incoming?: string): string {
  if (!current) return incoming ?? '';
  if (!incoming) return current;
  return timestampMs(current) >= timestampMs(incoming) ? current : incoming;
}

function pickEarliestTimestamp(current?: string, incoming?: string): string {
  if (!current) return incoming ?? '';
  if (!incoming) return current;
  return timestampMs(current) <= timestampMs(incoming) ? current : incoming;
}

function mergeEndedAt(current: Session, incoming: Session, status: string): string | undefined {
  if (status !== 'ended') return undefined;

  const currentEndedAt = current.ended_at;
  const incomingEndedAt = incoming.ended_at;
  if (!currentEndedAt) return incomingEndedAt;
  if (!incomingEndedAt) return currentEndedAt;
  return timestampMs(currentEndedAt) >= timestampMs(incomingEndedAt) ? currentEndedAt : incomingEndedAt;
}

export function mergeSessionAggregates(current: Session, incoming: Session): Session {
  const currentLastEventAt = timestampMs(current.last_event_at);
  const incomingLastEventAt = timestampMs(incoming.last_event_at);
  const preferCurrent = currentLastEventAt >= incomingLastEventAt;
  const status = preferCurrent ? current.status : incoming.status;

  return {
    ...current,
    ...incoming,
    status,
    project: current.project || incoming.project,
    branch: current.branch || incoming.branch,
    started_at: pickEarliestTimestamp(current.started_at, incoming.started_at),
    ended_at: mergeEndedAt(current, incoming, status),
    last_event_at: pickLatestTimestamp(current.last_event_at, incoming.last_event_at),
    event_count: Math.max(current.event_count || 0, incoming.event_count || 0),
    tokens_in: Math.max(current.tokens_in || 0, incoming.tokens_in || 0),
    tokens_out: Math.max(current.tokens_out || 0, incoming.tokens_out || 0),
    total_cost_usd: Math.max(current.total_cost_usd || 0, incoming.total_cost_usd || 0),
    files_edited: Math.max(current.files_edited || 0, incoming.files_edited || 0),
    lines_added: Math.max(current.lines_added || 0, incoming.lines_added || 0),
    lines_removed: Math.max(current.lines_removed || 0, incoming.lines_removed || 0),
  };
}
