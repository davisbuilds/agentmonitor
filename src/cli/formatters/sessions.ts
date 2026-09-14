import type {
  BrowsingSessionRow,
  LiveItemRow,
  LiveSessionRow,
  LiveSettings,
  LiveTurnRow,
  MessageRow,
  PinnedMessageRow,
  SessionActivity,
} from '../../api/v2/types.js';
import { formatTable, sanitizeTerminal } from '../output.js';

function short(value: string | null | undefined, max = 36): string {
  const clean = sanitizeTerminal(value ?? '-').replace(/\s+/g, ' ').trim() || '-';
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export function formatSessionRows(rows: BrowsingSessionRow[]): string {
  if (rows.length === 0) return '(no sessions)';
  return formatTable([
    ['ID', 'PROJECT', 'AGENT', 'MESSAGES', 'STARTED', 'PREVIEW'],
    ...rows.map(row => [
      short(row.id, 28),
      short(row.project, 18),
      short(row.agent, 12),
      String(row.message_count),
      short(row.started_at, 16),
      short(row.first_message, 48),
    ]),
  ]);
}

export function formatSessionDetail(row: BrowsingSessionRow): string {
  return [
    `ID: ${sanitizeTerminal(row.id)}`,
    `Project: ${sanitizeTerminal(row.project ?? '-')}`,
    `Agent: ${sanitizeTerminal(row.agent)}`,
    `Started: ${sanitizeTerminal(row.started_at ?? '-')}`,
    `Ended: ${sanitizeTerminal(row.ended_at ?? '-')}`,
    `Messages: ${row.message_count} (${row.user_message_count} user)`,
    `Live: ${sanitizeTerminal(row.live_status ?? '-')} / ${sanitizeTerminal(row.fidelity ?? '-')}`,
    `File: ${sanitizeTerminal(row.file_path ?? '-')}`,
    `Preview: ${short(row.first_message, 120)}`,
  ].join('\n');
}

export function formatMessages(rows: MessageRow[]): string {
  if (rows.length === 0) return '(no messages)';
  return rows.map(row => {
    const ts = row.timestamp ? ` ${sanitizeTerminal(row.timestamp.slice(0, 19))}` : '';
    return `--- #${row.ordinal} ${sanitizeTerminal(row.role)}${ts} ---\n${short(row.content, 1000)}`;
  }).join('\n\n');
}

export function formatPins(rows: PinnedMessageRow[]): string {
  if (rows.length === 0) return '(no pins)';
  return formatTable([
    ['SESSION', 'ORDINAL', 'PROJECT', 'AGENT', 'CONTENT'],
    ...rows.map(row => [
      short(row.session_id, 28),
      String(row.message_ordinal),
      short(row.session_project, 18),
      short(row.session_agent, 12),
      short(row.content, 60),
    ]),
  ]);
}

export function formatSessionActivity(activity: SessionActivity): string {
  return [
    `Messages: ${activity.total_messages}`,
    `Buckets: ${activity.bucket_count}`,
    `Timestamped: ${activity.timestamped_messages}`,
    `Untimestamped: ${activity.untimestamped_messages}`,
    `Navigation: ${sanitizeTerminal(activity.navigation_basis)}`,
    `Range: ${sanitizeTerminal(activity.first_timestamp ?? '-')} to ${sanitizeTerminal(activity.last_timestamp ?? '-')}`,
  ].join('\n');
}

export function formatLiveSessions(rows: LiveSessionRow[]): string {
  if (rows.length === 0) return '(no live sessions)';
  return formatTable([
    ['ID', 'PROJECT', 'AGENT', 'STATUS', 'FIDELITY', 'LAST ITEM'],
    ...rows.map(row => [
      short(row.id, 28),
      short(row.project, 18),
      short(row.agent, 12),
      short(row.live_status, 12),
      short(row.fidelity, 12),
      short(row.last_item_at ?? row.started_at, 20),
    ]),
  ]);
}

export function formatLiveItems(rows: LiveItemRow[]): string {
  if (rows.length === 0) return '(no live items)';
  return rows.map(row => {
    return `#${row.id} ${sanitizeTerminal(row.kind)} ${sanitizeTerminal(row.status ?? '-')}\n${short(row.payload_json, 1000)}`;
  }).join('\n\n');
}

export function formatLiveSettings(settings: LiveSettings): string {
  return [
    `Enabled: ${settings.enabled}`,
    `Codex mode: ${sanitizeTerminal(settings.codex_mode)}`,
    `Capture prompts: ${settings.capture.prompts}`,
    `Capture reasoning: ${settings.capture.reasoning}`,
    `Capture tool arguments: ${settings.capture.tool_arguments}`,
    `Diff payload max bytes: ${settings.diff_payload_max_bytes}`,
  ].join('\n');
}

export function formatLiveTurns(rows: LiveTurnRow[]): string {
  if (rows.length === 0) return '(no live turns)';
  return formatTable([
    ['ID', 'SOURCE TURN', 'STATUS', 'TITLE', 'STARTED', 'ENDED'],
    ...rows.map(row => [
      String(row.id),
      short(row.source_turn_id, 28),
      short(row.status, 12),
      short(row.title, 36),
      short(row.started_at, 20),
      short(row.ended_at, 20),
    ]),
  ]);
}
