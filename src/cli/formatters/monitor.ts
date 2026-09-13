import type {
  MonitorEventRow,
  MonitorFilterOptions,
  MonitorSessionRow,
  MonitorStats,
  MonitorToolStat,
  MonitorTranscriptEntry,
} from '../../api/v2/types.js';
import { formatTable, sanitizeTerminal } from '../output.js';

function short(value: unknown, max = 36): string {
  const clean = sanitizeTerminal(value ?? '-').replace(/\s+/g, ' ').trim() || '-';
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export function formatMonitorStats(stats: MonitorStats): string {
  return [
    `Events: ${stats.total_events}`,
    `Sessions: ${stats.total_sessions} total / ${stats.live_sessions} live / ${stats.active_sessions} active`,
    `Agents: ${stats.active_agents}`,
    `Tokens: ${stats.total_tokens_in} in / ${stats.total_tokens_out} out`,
    `Cost: $${stats.total_cost_usd.toFixed(4)}`,
  ].join('\n');
}

export function formatMonitorEvents(events: MonitorEventRow[]): string {
  if (events.length === 0) return '(no monitor events)';
  return formatTable([
    ['ID', 'SESSION', 'AGENT', 'TYPE', 'TOOL', 'STATUS', 'CREATED'],
    ...events.map(event => [
      String(event.id),
      short(event.session_id, 24),
      short(event.agent_type, 12),
      short(event.event_type, 18),
      short(event.tool_name, 18),
      short(event.status, 10),
      short(event.created_at, 20),
    ]),
  ]);
}

export function formatMonitorSessions(sessions: MonitorSessionRow[]): string {
  if (sessions.length === 0) return '(no monitor sessions)';
  return formatTable([
    ['ID', 'PROJECT', 'AGENT', 'STATUS', 'MODE', 'EVENTS', 'LAST EVENT'],
    ...sessions.map(session => [
      short(session.id, 24),
      short(session.project, 18),
      short(session.agent_type, 12),
      short(session.status, 10),
      short(session.mode, 12),
      String(session.event_count),
      short(session.last_event_at, 20),
    ]),
  ]);
}

export function formatMonitorFilterOptions(options: MonitorFilterOptions): string {
  return formatTable([
    ['DIMENSION', 'VALUES'],
    ['AGENT TYPES', options.agent_types.map(value => short(value)).join(', ') || '-'],
    ['EVENT TYPES', options.event_types.map(value => short(value)).join(', ') || '-'],
    ['TOOLS', options.tool_names.map(value => short(value)).join(', ') || '-'],
    ['MODELS', options.models.map(value => short(value)).join(', ') || '-'],
    ['PROJECTS', options.projects.map(value => short(value)).join(', ') || '-'],
    ['BRANCHES', options.branches.map(value => short(value.label)).join(', ') || '-'],
    ['SOURCES', options.sources.map(value => short(value)).join(', ') || '-'],
  ]);
}

export function formatMonitorTools(tools: MonitorToolStat[]): string {
  if (tools.length === 0) return '(no monitor tools)';
  return formatTable([
    ['TOOL', 'CALLS', 'ERRORS', 'ERROR RATE', 'AVG DURATION'],
    ...tools.map(tool => [
      short(tool.tool_name, 28),
      String(tool.total_calls),
      String(tool.error_count),
      `${(tool.error_rate * 100).toFixed(1)}%`,
      tool.avg_duration_ms == null ? '-' : `${tool.avg_duration_ms.toFixed(1)}ms`,
    ]),
  ]);
}

export function formatMonitorDetail(session: MonitorSessionRow, events: MonitorEventRow[]): string {
  return [
    `ID: ${sanitizeTerminal(session.id)}`,
    `Project: ${sanitizeTerminal(session.project ?? '-')}`,
    `Agent: ${sanitizeTerminal(session.agent_type)}`,
    `Status: ${sanitizeTerminal(session.status)}`,
    `Mode: ${sanitizeTerminal(session.mode ?? '-')}`,
    `Events: ${session.event_count}`,
    `Tokens: ${session.tokens_in} in / ${session.tokens_out} out`,
    `Cost: $${session.total_cost_usd.toFixed(4)}`,
    '',
    formatMonitorEvents(events),
  ].join('\n');
}

export function formatMonitorTranscript(entries: MonitorTranscriptEntry[]): string {
  if (entries.length === 0) return '(no monitor transcript)';
  return entries.map(entry => {
    const tool = entry.tool_name ? ` ${sanitizeTerminal(entry.tool_name)}` : '';
    const detail = entry.detail ? `\n${sanitizeTerminal(entry.detail)}` : '';
    return `${sanitizeTerminal(entry.timestamp)} ${sanitizeTerminal(entry.role)} ${sanitizeTerminal(entry.type)}${tool}${detail}`;
  }).join('\n\n');
}
