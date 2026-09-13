import { parseDateOption, parseIntegerOption, parseOptionSet, requireOne } from '../args.js';
import { registerCommand } from '../commands.js';
import { initReadDb } from '../db.js';
import { invalidUsage, notFound } from '../errors.js';
import {
  formatMonitorDetail,
  formatMonitorEvents,
  formatMonitorFilterOptions,
  formatMonitorSessions,
  formatMonitorStats,
  formatMonitorTools,
  formatMonitorTranscript,
} from '../formatters/monitor.js';
import { effectiveBaseUrl } from '../http.js';
import { writeJson, writeStdout } from '../output.js';
import type { CliContext } from '../output.js';
import { streamSseData } from '../sse.js';
import type { MonitorEventsParams, MonitorSessionsParams, MonitorStatsParams, UsageParams } from '../../api/v2/types.js';

const MONITOR_EVENT_FLAGS = new Set([
  '--agent', '--event-type', '--tool-name', '--session-id', '--branch', '--model',
  '--source', '--since', '--until', '--limit', '--offset',
]);
const MONITOR_SESSION_FLAGS = new Set([
  '--status', '--exclude-status', '--project', '--agent', '--date-from', '--date-to', '--limit',
]);
const MONITOR_TOOL_FLAGS = new Set(['--project', '--agent', '--date-from', '--date-to']);

function writeMonitor(ctx: CliContext, value: unknown, human: string): void {
  if (ctx.global.json) writeJson(ctx, value);
  else writeStdout(ctx, human);
}

function parseValues(args: string[], flags: Set<string>): Map<string, string> {
  const parsed = parseOptionSet(args, flags, new Set());
  if (parsed.positionals.length > 0) throw invalidUsage(`Unexpected argument: ${parsed.positionals[0]}`);
  return parsed.values;
}

function parseMonitorStats(args: string[]): MonitorStatsParams {
  const values = parseValues(args, new Set(['--agent', '--since']));
  return {
    agent: values.get('--agent'),
    since: parseDateOption(values.get('--since'), '--since'),
  };
}

function parseMonitorEvents(args: string[]): MonitorEventsParams {
  const values = parseValues(args, MONITOR_EVENT_FLAGS);
  return {
    agent: values.get('--agent'),
    event_type: values.get('--event-type'),
    tool_name: values.get('--tool-name'),
    session_id: values.get('--session-id'),
    branch: values.get('--branch'),
    model: values.get('--model'),
    source: values.get('--source'),
    since: parseDateOption(values.get('--since'), '--since'),
    until: parseDateOption(values.get('--until'), '--until'),
    limit: parseIntegerOption(values.get('--limit'), '--limit'),
    offset: parseIntegerOption(values.get('--offset'), '--offset'),
  };
}

function parseMonitorSessions(args: string[]): MonitorSessionsParams {
  const values = parseValues(args, MONITOR_SESSION_FLAGS);
  return {
    status: values.get('--status'),
    exclude_status: values.get('--exclude-status'),
    project: values.get('--project'),
    agent: values.get('--agent'),
    date_from: parseDateOption(values.get('--date-from'), '--date-from'),
    date_to: parseDateOption(values.get('--date-to'), '--date-to'),
    limit: parseIntegerOption(values.get('--limit'), '--limit'),
  };
}

function parseMonitorTools(args: string[]): UsageParams {
  const values = parseValues(args, MONITOR_TOOL_FLAGS);
  return {
    project: values.get('--project'),
    agent: values.get('--agent'),
    date_from: parseDateOption(values.get('--date-from'), '--date-from'),
    date_to: parseDateOption(values.get('--date-to'), '--date-to'),
  };
}

function parseDetailArgs(args: string[]): { id: string; eventLimit: number | undefined } {
  const parsed = parseOptionSet(args, new Set(['--event-limit']), new Set());
  return {
    id: requireOne(parsed.positionals, 'amon monitor show <id> [--event-limit <n>]'),
    eventLimit: parseIntegerOption(parsed.values.get('--event-limit'), '--event-limit'),
  };
}

export function registerMonitorCommands(): void {
  registerCommand({
    name: 'monitor stats',
    group: 'Monitor Commands',
    summary: 'Show real-time Monitor aggregate stats',
    usage: 'monitor stats [--agent <type>] [--since <timestamp>] [--json]',
    async handler(ctx, args) {
      const params = parseMonitorStats(args);
      const { closeDb } = await initReadDb();
      try {
        const { getMonitorStats } = await import('../../db/v2-queries.js');
        const result = getMonitorStats(params);
        writeMonitor(ctx, result, formatMonitorStats(result));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor events',
    group: 'Monitor Commands',
    summary: 'List real-time Monitor events',
    usage: 'monitor events [--agent <type>] [--event-type <type>] [--tool-name <name>] [--session-id <id>] [--branch <name>] [--model <name>] [--source <name>] [--since <timestamp>] [--until <timestamp>] [--limit <n>] [--offset <n>] [--json]',
    async handler(ctx, args) {
      const params = parseMonitorEvents(args);
      const { closeDb } = await initReadDb();
      try {
        const { listMonitorEvents } = await import('../../db/v2-queries.js');
        const result = listMonitorEvents(params);
        writeMonitor(ctx, result, formatMonitorEvents(result.events));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor sessions',
    group: 'Monitor Commands',
    summary: 'List real-time Monitor sessions',
    usage: 'monitor sessions [--status <status>] [--exclude-status <status>] [--project <name>] [--agent <type>] [--date-from <date>] [--date-to <date>] [--limit <n>] [--json]',
    async handler(ctx, args) {
      const params = parseMonitorSessions(args);
      const { closeDb } = await initReadDb();
      try {
        const { listMonitorSessions } = await import('../../db/v2-queries.js');
        const result = listMonitorSessions(params);
        writeMonitor(ctx, result, formatMonitorSessions(result.sessions));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor filter-options',
    group: 'Monitor Commands',
    summary: 'Show Monitor filter values',
    usage: 'monitor filter-options [--json]',
    async handler(ctx, args) {
      parseValues(args, new Set());
      const { closeDb } = await initReadDb();
      try {
        const { getMonitorFilterOptions } = await import('../../db/v2-queries.js');
        const result = getMonitorFilterOptions();
        writeMonitor(ctx, result, formatMonitorFilterOptions(result));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor tools',
    group: 'Monitor Commands',
    summary: 'Show Monitor tool aggregates',
    usage: 'monitor tools [--project <name>] [--agent <type>] [--date-from <date>] [--date-to <date>] [--json]',
    async handler(ctx, args) {
      const params = parseMonitorTools(args);
      const { closeDb } = await initReadDb();
      try {
        const { getMonitorToolStats } = await import('../../db/v2-queries.js');
        const tools = getMonitorToolStats(params);
        writeMonitor(ctx, { tools }, formatMonitorTools(tools));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor show',
    group: 'Monitor Commands',
    summary: 'Show one Monitor session with recent events',
    usage: 'monitor show <id> [--event-limit <n>] [--json]',
    async handler(ctx, args) {
      const { id, eventLimit } = parseDetailArgs(args);
      const { closeDb } = await initReadDb();
      try {
        const { getMonitorSessionWithEvents } = await import('../../db/v2-queries.js');
        const result = getMonitorSessionWithEvents(id, eventLimit ?? 10);
        if (!result.session) throw notFound(`Session not found: ${id}`);
        writeMonitor(ctx, result, formatMonitorDetail(result.session, result.events));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor transcript',
    group: 'Monitor Commands',
    summary: 'Show one Monitor event transcript',
    usage: 'monitor transcript <id> [--json]',
    async handler(ctx, args) {
      const parsed = parseOptionSet(args, new Set(), new Set());
      const id = requireOne(parsed.positionals, 'amon monitor transcript <id>');
      const { closeDb } = await initReadDb();
      try {
        const { getMonitorSessionTranscript } = await import('../../db/v2-queries.js');
        const result = getMonitorSessionTranscript(id);
        if (!result) throw notFound(`No transcript data for session: ${id}`);
        writeMonitor(ctx, result, formatMonitorTranscript(result.entries));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'monitor watch',
    group: 'Monitor Commands',
    summary: 'Stream Monitor SSE events as NDJSON',
    usage: 'monitor watch [--agent <type>] [--event-type <type>] [--url <url>]',
    async handler(ctx, args) {
      const values = parseValues(args, new Set(['--agent', '--event-type']));
      const url = new URL(`${effectiveBaseUrl(ctx.global.url)}/api/stream`);
      const agent = values.get('--agent');
      const eventType = values.get('--event-type');
      if (agent) url.searchParams.set('agent_type', agent);
      if (eventType) url.searchParams.set('event_type', eventType);
      await streamSseData(ctx, url);
    },
  });
}
