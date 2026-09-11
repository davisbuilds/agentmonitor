import { parseIntegerOption, parseOptionSet } from '../args.js';
import { registerCommand } from '../commands.js';
import { invalidUsage } from '../errors.js';
import { formatOpsMetrics } from '../formatters/ops.js';
import { writeJson, writeStdout } from '../output.js';

export function registerOpsCommands(): void {
  registerCommand({
    name: 'ops metrics',
    group: 'Operational Commands',
    summary: 'Show operational OTEL metrics (outcome/state-tagged counters)',
    usage: 'ops metrics [--name-prefix <s>] [--agent <type>] [--session <id>] [--since <iso>] [--limit <n>] [--json]',
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
        since: parsed.values.get('--since'),
        limit: parseIntegerOption(parsed.values.get('--limit'), '--limit'),
      };

      const { initSchema } = await import('../../db/schema.js');
      const { closeDb } = await import('../../db/connection.js');
      initSchema();
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
