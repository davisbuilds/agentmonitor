import { parseIntegerOption, parseOptionSet } from '../args.js';
import { registerCommand } from '../commands.js';
import { invalidUsage } from '../errors.js';
import { formatOpsMetrics } from '../formatters/ops.js';
import { writeJson, writeStdout } from '../output.js';
import { initReadDb } from '../db.js';

const RELATIVE_SINCE_RE = /^(\d+)(s|m|h|d|w)$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve a `--since` value to an absolute lower bound the query can compare.
 * A relative shorthand (`1h`, `30m`, `7d`, `2w`) becomes an ISO timestamp
 * `now - duration`; anything else (an ISO/datetime string) passes through for
 * SQLite `datetime()` to parse. Returns undefined when no bound was given.
 */
export function resolveSince(value: string | undefined, now: number = Date.now()): string | undefined {
  if (value == null) return undefined;
  const match = RELATIVE_SINCE_RE.exec(value);
  if (match) {
    const amount = Number(match[1]);
    return new Date(now - amount * UNIT_MS[match[2]]).toISOString();
  }
  // A non-relative value is an absolute timestamp. Reject anything unparsable:
  // SQLite datetime() would evaluate it to NULL and return an empty result,
  // falsely implying no operational events occurred.
  if (Number.isNaN(Date.parse(value))) {
    throw invalidUsage(`Invalid --since: ${value} (use an ISO timestamp or a relative window like 1h, 30m, 7d)`);
  }
  return value;
}

export function registerOpsCommands(): void {
  registerCommand({
    name: 'ops metrics',
    group: 'Operational Commands',
    summary: 'Show operational OTEL metrics (outcome/state-tagged counters)',
    usage: 'ops metrics [--name-prefix <s>] [--agent <type>] [--session <id>] [--since <iso|1h|30m|7d>] [--limit <n>] [--json]',
    async handler(ctx, args) {
      const parsed = parseOptionSet(
        args,
        new Set(['--name-prefix', '--agent', '--session', '--since', '--limit']),
        new Set(),
      );
      if (parsed.positionals.length > 0) throw invalidUsage(`Unexpected argument: ${parsed.positionals[0]}`);

      const query = {
        namePrefix: parsed.values.get('--name-prefix'),
        agentType: parsed.values.get('--agent'),
        sessionId: parsed.values.get('--session'),
        since: resolveSince(parsed.values.get('--since')),
        limit: parseIntegerOption(parsed.values.get('--limit'), '--limit'),
      };

      const { closeDb } = await initReadDb();
      try {
        const { getOperationalMetricSummary } = await import('../../db/v2-queries.js');
        const metrics = getOperationalMetricSummary(query);
        if (ctx.global.json) writeJson(ctx, { metrics });
        else writeStdout(ctx, formatOpsMetrics(metrics));
      } finally {
        closeDb();
      }
    },
  });
}
