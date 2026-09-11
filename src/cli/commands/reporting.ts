import { parseDateOption, parseIntegerOption, parseOptionSet } from '../args.js';
import { registerCommand } from '../commands.js';
import { invalidUsage } from '../errors.js';
import { formatCurrency, formatRows, formatUsageFacets, formatUsageOverview, formatUsageSummary } from '../formatters/reporting.js';
import { writeJson, writeStdout } from '../output.js';
import type { CliContext } from '../output.js';
import { initReadDb } from '../db.js';
import type { AnalyticsParams, TraceQualityTraceListParams, UsageParams } from '../../api/v2/types.js';

const USAGE_FLAGS = new Set([
  '--date-from', '--date-to', '--project', '--agent', '--model', '--provider', '--tier',
]);
const ANALYTICS_FLAGS = new Set(['--date-from', '--date-to', '--project', '--agent']);
const QUALITY_TRACE_FLAGS = new Set([
  '--date-from', '--date-to', '--project', '--agent', '--session-id', '--limit', '--offset',
]);

function parseValues(args: string[], valueFlags: Set<string>) {
  const parsed = parseOptionSet(args, valueFlags, new Set());
  if (parsed.positionals.length > 0) throw invalidUsage(`Unexpected argument: ${parsed.positionals[0]}`);
  return parsed.values;
}

function parseUsageParams(args: string[]): UsageParams {
  const values = parseValues(args, USAGE_FLAGS);
  return {
    date_from: parseDateOption(values.get('--date-from'), '--date-from'),
    date_to: parseDateOption(values.get('--date-to'), '--date-to'),
    project: values.get('--project'),
    agent: values.get('--agent'),
    model: values.get('--model'),
    provider: values.get('--provider'),
    tier: values.get('--tier'),
  };
}

function parseAnalyticsParams(args: string[], withLimit = false): AnalyticsParams {
  const flags = withLimit ? new Set([...ANALYTICS_FLAGS, '--limit']) : ANALYTICS_FLAGS;
  const values = parseValues(args, flags);
  return {
    date_from: parseDateOption(values.get('--date-from'), '--date-from'),
    date_to: parseDateOption(values.get('--date-to'), '--date-to'),
    project: values.get('--project'),
    agent: values.get('--agent'),
    limit: withLimit ? parseIntegerOption(values.get('--limit'), '--limit') : undefined,
  };
}

function parseQualityTraceParams(args: string[]): TraceQualityTraceListParams {
  const values = parseValues(args, QUALITY_TRACE_FLAGS);
  return {
    date_from: parseDateOption(values.get('--date-from'), '--date-from'),
    date_to: parseDateOption(values.get('--date-to'), '--date-to'),
    project: values.get('--project'),
    agent: values.get('--agent'),
    session_id: values.get('--session-id'),
    limit: parseIntegerOption(values.get('--limit'), '--limit'),
    offset: parseIntegerOption(values.get('--offset'), '--offset'),
  };
}

function rejectOptions(args: string[]): void {
  parseValues(args, new Set());
}

function writeReport(ctx: CliContext, value: unknown, human: string): void {
  if (ctx.global.json) writeJson(ctx, value);
  else writeStdout(ctx, human);
}

const USAGE_FILTER_HELP = '[--date-from <date>] [--date-to <date>] [--project <name>] [--agent <type>] [--model <name>] [--provider <name>] [--tier <name>]';
const ANALYTICS_FILTER_HELP = '[--date-from <date>] [--date-to <date>] [--project <name>] [--agent <type>]';

export function registerReportingCommands(): void {
  registerCommand({
    name: 'usage overview',
    group: 'Usage Commands',
    summary: 'Show every Usage-page rollup from one scan',
    usage: `usage overview ${USAGE_FILTER_HELP} [--json]`,
    examples: ['usage overview --date-from 2026-09-01 --json', 'usage overview --project agentmonitor --agent codex --json'],
    async handler(ctx, args) {
      const params = parseUsageParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageOverview } = await import('../../db/v2-queries.js');
        const overview = getUsageOverview(params);
        writeReport(ctx, overview, formatUsageOverview(overview));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'usage facets',
    group: 'Usage Commands',
    summary: 'Show self-excluding Usage filter values',
    usage: `usage facets ${USAGE_FILTER_HELP} [--json]`,
    examples: ['usage facets --json', 'usage facets --project agentmonitor --json'],
    async handler(ctx, args) {
      const params = parseUsageParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageFacets } = await import('../../db/v2-queries.js');
        const facets = getUsageFacets(params);
        writeReport(ctx, facets, formatUsageFacets(facets));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'usage summary',
    group: 'Usage Commands',
    summary: 'Show usage cost and token totals',
    usage: `usage summary ${USAGE_FILTER_HELP} [--json]`,
    async handler(ctx, args) {
      const params = parseUsageParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageSummary } = await import('../../db/v2-queries.js');
        const summary = getUsageSummary(params);
        writeReport(ctx, summary, formatUsageSummary(summary));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'usage daily',
    group: 'Usage Commands',
    summary: 'Show daily usage costs',
    usage: `usage daily ${USAGE_FILTER_HELP} [--json]`,
    async handler(ctx, args) {
      const params = parseUsageParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageCoverage, getUsageDaily } = await import('../../db/v2-queries.js');
        const payload = { data: getUsageDaily(params), coverage: getUsageCoverage(params) };
        writeReport(ctx, payload, formatRows(payload.data as unknown as Array<Record<string, unknown>>, ['date', 'cost_usd', 'usage_events', 'session_count']));
      } finally {
        closeDb();
      }
    },
  });

  for (const [name, summary, getter, columns] of [
    ['usage models', 'Show usage grouped by model', 'getUsageModels', ['model', 'provider', 'tier', 'cost_usd', 'usage_events']],
    ['usage projects', 'Show usage grouped by project', 'getUsageProjects', ['project', 'cost_usd', 'usage_events', 'session_count']],
  ] as const) {
    registerCommand({
      name,
      group: 'Usage Commands',
      summary,
      usage: `${name} ${USAGE_FILTER_HELP} [--json]`,
      async handler(ctx, args) {
        const params = parseUsageParams(args);
        const { closeDb } = await initReadDb();
        try {
          const queries = await import('../../db/v2-queries.js');
          const data = queries[getter](params);
          const coverage = queries.getUsageCoverage(params);
          const payload = { data, coverage };
          writeReport(ctx, payload, formatRows(data as unknown as Array<Record<string, unknown>>, columns as unknown as string[]));
        } finally {
          closeDb();
        }
      },
    });
  }

  registerCommand({
    name: 'usage statusline',
    group: 'Usage Commands',
    summary: 'Print a one-line cost summary',
    usage: `usage statusline ${USAGE_FILTER_HELP} [--plain]`,
    async handler(ctx, args) {
      const params = parseUsageParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageSummary } = await import('../../db/v2-queries.js');
        const summary = getUsageSummary(params);
        const line = ctx.global.plain ? `${formatCurrency(summary.total_cost_usd)} today` : `AgentMonitor ${formatCurrency(summary.total_cost_usd)} usage`;
        writeStdout(ctx, line);
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'usage budgets',
    group: 'Usage Commands',
    summary: 'Show read-only usage budget state',
    usage: 'usage budgets [--json]',
    async handler(ctx, args) {
      rejectOptions(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageBudgets } = await import('../../usage/budgets.js');
        const budgets = getUsageBudgets();
        writeReport(ctx, budgets, formatRows(budgets.data as unknown as Array<Record<string, unknown>>, ['name', 'spent_usd', 'limit_usd', 'state']));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'usage tier-feedback',
    group: 'Usage Commands',
    summary: 'Show advisory model-tier feedback',
    usage: `usage tier-feedback ${USAGE_FILTER_HELP} [--json]`,
    async handler(ctx, args) {
      const params = parseUsageParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { getUsageTierFeedback } = await import('../../usage/tier-feedback.js');
        const report = getUsageTierFeedback(params);
        writeReport(ctx, report, `Tier feedback: ${report.tier_mismatches.length} mismatch(es), ${report.cost_outliers.length} cost outlier(s)`);
      } finally {
        closeDb();
      }
    },
  });

  for (const [name, summary, getter, columns] of [
    ['analytics summary', 'Show historical session analytics summary', 'getAnalyticsSummary', ['total_sessions', 'total_messages', 'total_user_messages']],
    ['analytics tools', 'Show tool analytics', 'getAnalyticsTools', ['tool_name', 'category', 'count']],
    ['analytics top-sessions', 'Show top historical sessions', 'getAnalyticsTopSessions', ['id', 'project', 'agent', 'message_count', 'tool_call_count']],
  ] as const) {
    registerCommand({
      name,
      group: 'Analytics Commands',
      summary,
      usage: `${name} ${ANALYTICS_FILTER_HELP}${name === 'analytics top-sessions' ? ' [--limit <n>]' : ''} [--json]`,
      async handler(ctx, args) {
        const params = parseAnalyticsParams(args, name === 'analytics top-sessions');
        const { closeDb } = await initReadDb();
        try {
          const queries = await import('../../db/v2-queries.js');
          const data = queries[getter](params);
          const payload = Array.isArray(data) ? { data, coverage: queries.getAnalyticsCoverage(params, name === 'analytics tools' ? 'tool_analytics_capable' : 'all_sessions') } : data;
          const human = Array.isArray(data)
            ? formatRows(data as unknown as Array<Record<string, unknown>>, columns as unknown as string[])
            : formatRows([data as unknown as Record<string, unknown>], columns as unknown as string[]);
          writeReport(ctx, payload, human);
        } finally {
          closeDb();
        }
      },
    });
  }

  registerCommand({
    name: 'quality traces',
    group: 'Quality Commands',
    summary: 'List trace-quality traces (one per session, from the lean summary)',
    usage: 'quality traces [--date-from <date>] [--date-to <date>] [--project <name>] [--agent <type>] [--session-id <id>] [--limit <n>] [--offset <n>] [--json]',
    async handler(ctx, args) {
      const params = parseQualityTraceParams(args);
      const { closeDb } = await initReadDb();
      try {
        const { ensureSessionTraceSummaryBackfill } = await import('../../trace-quality/summary.js');
        const { listSessionTraces } = await import('../../trace-quality/on-demand.js');
        // The CLI runs out-of-band from the server, so self-heal the summary here
        // too — otherwise an upgraded DB with events but no summary rows reports an
        // empty list until the server has run its startup backfill.
        ensureSessionTraceSummaryBackfill();
        const result = listSessionTraces(params);
        writeReport(ctx, result, formatRows(result.data as unknown as Array<Record<string, unknown>>, ['id', 'session_id', 'agent_type', 'status']));
      } finally {
        closeDb();
      }
    },
  });
}
