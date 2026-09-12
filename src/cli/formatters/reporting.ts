import { formatTable, sanitizeTerminal } from '../output.js';
import type { UsageFacets, UsageOverview } from '../../api/v2/types.js';

export function formatCurrency(value: number | null | undefined): string {
  return `$${(value ?? 0).toFixed(4)}`;
}

export function formatUsageSummary(summary: { total_cost_usd: number; total_usage_events: number; total_sessions: number; total_input_tokens: number; total_output_tokens: number }): string {
  return [
    `Cost: ${formatCurrency(summary.total_cost_usd)}`,
    `Usage events: ${summary.total_usage_events}`,
    `Sessions: ${summary.total_sessions}`,
    `Tokens: ${summary.total_input_tokens} in / ${summary.total_output_tokens} out`,
  ].join('\n');
}

export function formatUsageOverview(overview: UsageOverview): string {
  return [
    formatUsageSummary(overview.summary),
    `Daily points: ${overview.daily.length}`,
    `Projects: ${overview.projects.length}`,
    `Models: ${overview.models.length}`,
    `Model-day points: ${overview.models_daily.length}`,
    `Tiers: ${overview.tiers.length}`,
    `Agents: ${overview.agents.length}`,
    `Top sessions: ${overview.top_sessions.length}`,
  ].join('\n');
}

export function formatUsageFacets(facets: UsageFacets): string {
  return formatTable([
    ['DIMENSION', 'VALUES'],
    ...Object.entries(facets).map(([dimension, values]) => [
      dimension.toUpperCase(),
      sanitizeTerminal(values.join(', ') || '-'),
    ]),
  ]);
}

export function formatRows(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return '(no rows)';
  return formatTable([
    columns.map(column => column.toUpperCase()),
    ...rows.map(row => columns.map(column => sanitizeTerminal(row[column] ?? '-'))),
  ]);
}
