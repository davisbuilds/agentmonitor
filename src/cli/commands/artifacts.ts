import { parseDateOption, parseIntegerOption, parseOptionSet, requireOne } from '../args.js';
import { registerCommand } from '../commands.js';
import { initReadDb } from '../db.js';
import { invalidUsage, notFound } from '../errors.js';
import {
  formatBenchmarkStudies,
  formatBenchmarkStudy,
  formatInsight,
  formatInsights,
  formatObservations,
  formatStringList,
  formatTraceDetail,
} from '../formatters/artifacts.js';
import { writeJson, writeStdout } from '../output.js';
import type { CliContext } from '../output.js';
import type { InsightKind, InsightsListParams, TraceQualityObservationListParams } from '../../api/v2/types.js';

const INSIGHT_LIST_FLAGS = new Set([
  '--date-from', '--date-to', '--project', '--agent', '--kind', '--limit',
]);
const OBSERVATION_FLAGS = new Set(['--limit', '--offset']);
const INSIGHT_KINDS = new Set<InsightKind>(['overview', 'workflow', 'usage']);

function writeRead(ctx: CliContext, value: unknown, human: string): void {
  if (ctx.global.json) writeJson(ctx, value);
  else writeStdout(ctx, human);
}

function parseNoOptions(args: string[], usage: string): string {
  const parsed = parseOptionSet(args, new Set(), new Set());
  return requireOne(parsed.positionals, usage);
}

function rejectAllArgs(args: string[]): void {
  const parsed = parseOptionSet(args, new Set(), new Set());
  if (parsed.positionals.length > 0) throw invalidUsage(`Unexpected argument: ${parsed.positionals[0]}`);
}

function parseObservationArgs(args: string[]): { traceId: string; params: TraceQualityObservationListParams } {
  const parsed = parseOptionSet(args, OBSERVATION_FLAGS, new Set());
  return {
    traceId: requireOne(parsed.positionals, 'quality observations <id> [--limit <n>] [--offset <n>]'),
    params: {
      limit: parseIntegerOption(parsed.values.get('--limit'), '--limit'),
      offset: parseIntegerOption(parsed.values.get('--offset'), '--offset'),
    },
  };
}

function parseInsightsListArgs(args: string[]): InsightsListParams {
  const parsed = parseOptionSet(args, INSIGHT_LIST_FLAGS, new Set());
  if (parsed.positionals.length > 0) throw invalidUsage(`Unexpected argument: ${parsed.positionals[0]}`);
  const rawKind = parsed.values.get('--kind');
  if (rawKind && !INSIGHT_KINDS.has(rawKind as InsightKind)) {
    throw invalidUsage(`Invalid --kind: ${rawKind}`);
  }
  return {
    date_from: parseDateOption(parsed.values.get('--date-from'), '--date-from'),
    date_to: parseDateOption(parsed.values.get('--date-to'), '--date-to'),
    project: parsed.values.get('--project'),
    agent: parsed.values.get('--agent'),
    kind: rawKind as InsightKind | undefined,
    limit: parseIntegerOption(parsed.values.get('--limit'), '--limit'),
  };
}

async function openQualityRead(): Promise<{ closeDb: () => void }> {
  const opened = await initReadDb();
  try {
    const { ensureSessionTraceSummaryBackfill } = await import('../../trace-quality/summary.js');
    ensureSessionTraceSummaryBackfill();
    return opened;
  } catch (error) {
    opened.closeDb();
    throw error;
  }
}

export function registerArtifactCommands(): void {
  registerCommand({
    name: 'quality trace',
    group: 'Quality Commands',
    summary: 'Show one trace-quality trace',
    usage: 'quality trace <id> [--json]',
    async handler(ctx, args) {
      const traceId = parseNoOptions(args, 'quality trace <id>');
      const { closeDb } = await openQualityRead();
      try {
        const { getSessionTraceDetail } = await import('../../trace-quality/on-demand.js');
        const result = getSessionTraceDetail(traceId);
        if (!result) throw notFound(`Trace not found: ${traceId}`);
        writeRead(ctx, result, formatTraceDetail(result.trace));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'quality observations',
    group: 'Quality Commands',
    summary: 'List observations for one trace-quality trace',
    usage: 'quality observations <id> [--limit <n>] [--offset <n>] [--json]',
    async handler(ctx, args) {
      const { traceId, params } = parseObservationArgs(args);
      const { closeDb } = await openQualityRead();
      try {
        const { listSessionObservations } = await import('../../trace-quality/on-demand.js');
        const result = listSessionObservations(traceId, params);
        if (!result) throw notFound(`Trace not found: ${traceId}`);
        writeRead(ctx, result, formatObservations(result.data));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'insights list',
    group: 'Insights Commands',
    summary: 'List saved insights and generation availability',
    usage: 'insights list [--date-from <date>] [--date-to <date>] [--project <name>] [--agent <type>] [--kind <overview|workflow|usage>] [--limit <n>] [--json]',
    async handler(ctx, args) {
      const params = parseInsightsListArgs(args);
      const { closeDb } = await initReadDb();
      try {
        const { getInsightsListResponse } = await import('../../insights/responses.js');
        const result = getInsightsListResponse(params);
        writeRead(ctx, result, formatInsights(result.data));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'insights show',
    group: 'Insights Commands',
    summary: 'Show one saved insight',
    usage: 'insights show <id> [--json]',
    async handler(ctx, args) {
      const rawId = parseNoOptions(args, 'insights show <id>');
      const id = parseIntegerOption(rawId, 'insight id') as number;
      const { closeDb } = await initReadDb();
      try {
        const { getInsight } = await import('../../db/v2-queries.js');
        const result = getInsight(id);
        if (!result) throw notFound(`Insight not found: ${id}`);
        writeRead(ctx, result, formatInsight(result));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'benchmarks list',
    group: 'Benchmark Commands',
    summary: 'List benchmark studies',
    usage: 'benchmarks list [--json]',
    async handler(ctx, args) {
      rejectAllArgs(args);
      const { closeDb } = await initReadDb();
      try {
        const { getBenchmarkStudies } = await import('../../db/v2-queries.js');
        const result = { data: getBenchmarkStudies() };
        writeRead(ctx, result, formatBenchmarkStudies(result.data));
      } finally {
        closeDb();
      }
    },
  });

  registerCommand({
    name: 'benchmarks show',
    group: 'Benchmark Commands',
    summary: 'Show one benchmark study',
    usage: 'benchmarks show <study-id> [--json]',
    async handler(ctx, args) {
      const studyId = parseNoOptions(args, 'benchmarks show <study-id>');
      const { closeDb } = await initReadDb();
      try {
        const { getBenchmarkStudy } = await import('../../db/v2-queries.js');
        const result = getBenchmarkStudy(studyId);
        if (result.arms.length === 0) throw notFound(`Benchmark study not found: ${studyId}`);
        writeRead(ctx, result, formatBenchmarkStudy(result));
      } finally {
        closeDb();
      }
    },
  });

  for (const [name, label, getter] of [
    ['projects list', 'PROJECT', 'getDistinctProjects'],
    ['agents list', 'AGENT', 'getDistinctAgents'],
  ] as const) {
    registerCommand({
      name,
      group: 'Metadata Commands',
      summary: `List known ${label.toLowerCase()} values`,
      usage: `${name} [--json]`,
      async handler(ctx, args) {
        rejectAllArgs(args);
        const { closeDb } = await initReadDb();
        try {
          const queries = await import('../../db/v2-queries.js');
          const data = queries[getter]();
          writeRead(ctx, { data }, formatStringList(label, data));
        } finally {
          closeDb();
        }
      },
    });
  }
}
