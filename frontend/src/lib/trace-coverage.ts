import type {
  TraceQualityAggregateMetrics,
  TraceQualityCostCoverage,
  TraceQualityCostProvenance,
  TraceQualityCoverage,
  TraceQualityTimestampCoverage,
  TraceQualityToolOutcomeCoverage,
  TraceQualityUsageCoverage,
} from './api/client';
import { formatCost } from './format';

export type TraceCoverageTone = 'ok' | 'warn' | 'neutral';

export interface TraceCoveragePill {
  key: string;
  label: string;
  tone: TraceCoverageTone;
}

export interface TraceCoverageDetailEntry {
  key: string;
  label: string;
  value: string;
  tone: TraceCoverageTone;
}

export interface NormalizedTraceCoverage {
  has_full_transcript: boolean;
  has_tool_details: boolean;
  usage_coverage: TraceQualityUsageCoverage;
  cost_coverage: TraceQualityCostCoverage;
  cost_provenance: TraceQualityCostProvenance;
  timestamp_coverage: TraceQualityTimestampCoverage;
  tool_outcome_coverage: TraceQualityToolOutcomeCoverage;
}

const numberFmt = new Intl.NumberFormat('en-US');

export function normalizeTraceCoverage(
  coverage: TraceQualityCoverage | null | undefined,
  aggregate?: Pick<
    TraceQualityAggregateMetrics,
    'total_tokens_in' | 'total_tokens_out' | 'total_cache_read_tokens' | 'total_cache_write_tokens' | 'total_cost_usd'
  >,
): NormalizedTraceCoverage {
  const cov = coverage ?? {};
  const totalTokens = aggregate
    ? aggregate.total_tokens_in + aggregate.total_tokens_out + aggregate.total_cache_read_tokens + aggregate.total_cache_write_tokens
    : 0;
  const usage_coverage: TraceQualityUsageCoverage = cov.usage_coverage
    ?? (cov.has_token_usage === true
      ? (aggregate && totalTokens === 0 ? 'observed_zero' : 'observed')
      : totalTokens > 0 ? 'observed' : 'unavailable');
  const cost_coverage: TraceQualityCostCoverage = cov.cost_coverage
    ?? (cov.has_cost === true
      ? 'priced'
      : usage_coverage === 'unavailable'
        ? 'unavailable'
        : aggregate && aggregate.total_cost_usd > 0 ? 'priced' : 'unpriced');
  const cost_provenance: TraceQualityCostProvenance = cov.cost_provenance
    ?? (cost_coverage === 'unavailable' || cost_coverage === 'unpriced' ? 'unavailable' : 'unknown');
  const timestamp_coverage: TraceQualityTimestampCoverage = cov.timestamp_coverage ?? 'approximate';
  const tool_outcome_coverage: TraceQualityToolOutcomeCoverage = cov.tool_outcome_coverage
    ?? (cov.has_tool_details === true ? 'unrecorded' : 'not_applicable');
  return {
    has_full_transcript: cov.has_full_transcript === true,
    has_tool_details: cov.has_tool_details === true,
    usage_coverage,
    cost_coverage,
    cost_provenance,
    timestamp_coverage,
    tool_outcome_coverage,
  };
}

export function formatTraceTokens(
  aggregate: Pick<
    TraceQualityAggregateMetrics,
    'total_tokens_in' | 'total_tokens_out' | 'total_cache_read_tokens' | 'total_cache_write_tokens' | 'total_cost_usd'
  >,
  coverage: TraceQualityCoverage | null | undefined,
): string {
  const normalized = normalizeTraceCoverage(coverage, aggregate);
  if (normalized.usage_coverage === 'unavailable') return '—';
  if (normalized.usage_coverage === 'observed_zero') return '0';
  return numberFmt.format(aggregate.total_tokens_in + aggregate.total_tokens_out);
}

export function formatTraceCost(
  costUsd: number,
  coverage: TraceQualityCoverage | null | undefined,
  options: { compact?: boolean } = {},
): string {
  const normalized = normalizeTraceCoverage(coverage);
  if (normalized.cost_coverage === 'unavailable') return '—';
  if (normalized.cost_coverage === 'unpriced') return options.compact ? 'unpriced' : 'Unpriced';
  if (normalized.cost_coverage === 'partial') {
    return options.compact ? `${formatCost(costUsd)}*` : `${formatCost(costUsd)} (partial)`;
  }
  return formatCost(costUsd);
}

function costProvenanceSuffix(provenance: TraceQualityCostProvenance): string {
  if (provenance === 'estimated') return ' (estimated)';
  if (provenance === 'reported') return ' (reported)';
  if (provenance === 'mixed') return ' (mixed)';
  return '';
}

export function traceCoveragePills(
  coverage: TraceQualityCoverage | null | undefined,
): TraceCoveragePill[] {
  const normalized = normalizeTraceCoverage(coverage);
  const pills: TraceCoveragePill[] = [];

  if (normalized.has_full_transcript) {
    pills.push({ key: 'transcript', label: 'Full transcript', tone: 'ok' });
  }

  pills.push({
    key: 'tools',
    label: normalized.has_tool_details ? 'Tool calls' : 'Tool calls missing',
    tone: normalized.has_tool_details ? 'ok' : 'neutral',
  });

  if (normalized.usage_coverage === 'observed') {
    pills.push({ key: 'usage', label: 'Token usage', tone: 'ok' });
  } else if (normalized.usage_coverage === 'observed_zero') {
    pills.push({ key: 'usage', label: 'Usage 0 (measured)', tone: 'ok' });
  } else {
    pills.push({ key: 'usage', label: 'Usage unavailable', tone: 'neutral' });
  }

  if (normalized.cost_coverage === 'priced') {
    pills.push({ key: 'cost', label: `Cost${costProvenanceSuffix(normalized.cost_provenance)}`, tone: 'ok' });
  } else if (normalized.cost_coverage === 'partial') {
    pills.push({ key: 'cost', label: `Cost partial${costProvenanceSuffix(normalized.cost_provenance)}`, tone: 'warn' });
  } else if (normalized.cost_coverage === 'unpriced') {
    pills.push({ key: 'cost', label: 'Cost unpriced', tone: 'warn' });
  } else {
    pills.push({ key: 'cost', label: 'Cost unavailable', tone: 'neutral' });
  }

  if (normalized.timestamp_coverage === 'approximate') {
    pills.push({ key: 'timestamps', label: 'Approximate timestamps', tone: 'warn' });
  } else if (normalized.timestamp_coverage === 'unavailable') {
    pills.push({ key: 'timestamps', label: 'Timestamps unavailable', tone: 'warn' });
  }

  if (normalized.tool_outcome_coverage === 'complete') {
    pills.push({ key: 'outcomes', label: 'Tool outcomes', tone: 'ok' });
  } else if (normalized.tool_outcome_coverage === 'partial') {
    pills.push({ key: 'outcomes', label: 'Tool outcomes partial', tone: 'warn' });
  } else if (normalized.tool_outcome_coverage === 'unrecorded') {
    pills.push({ key: 'outcomes', label: 'Tool outcomes unrecorded', tone: 'warn' });
  }

  return pills;
}

export function sessionTraceCoverageEntries(
  coverage: TraceQualityCoverage | null | undefined,
): TraceCoverageDetailEntry[] {
  if (!coverage) return [];
  const normalized = normalizeTraceCoverage(coverage);
  const entries: TraceCoverageDetailEntry[] = [
    {
      key: 'usage',
      label: 'Token usage',
      value: normalized.usage_coverage === 'observed'
        ? 'Observed'
        : normalized.usage_coverage === 'observed_zero'
          ? 'Measured 0'
          : 'Unavailable',
      tone: normalized.usage_coverage === 'unavailable' ? 'neutral' : 'ok',
    },
    {
      key: 'cost',
      label: 'Cost',
      value: normalized.cost_coverage === 'priced'
        ? `Priced${costProvenanceSuffix(normalized.cost_provenance)}`
        : normalized.cost_coverage === 'partial'
          ? `Partial${costProvenanceSuffix(normalized.cost_provenance)}`
          : normalized.cost_coverage === 'unpriced'
            ? 'Unpriced'
            : 'Unavailable',
      tone: normalized.cost_coverage === 'priced'
        ? 'ok'
        : normalized.cost_coverage === 'unavailable' ? 'neutral' : 'warn',
    },
    {
      key: 'timestamps',
      label: 'Timestamps',
      value: normalized.timestamp_coverage === 'exact'
        ? 'Exact'
        : normalized.timestamp_coverage === 'approximate'
          ? 'Approximate'
          : 'Unavailable',
      tone: normalized.timestamp_coverage === 'exact' ? 'ok' : 'warn',
    },
  ];
  if (normalized.tool_outcome_coverage !== 'not_applicable') {
    entries.push({
      key: 'tool_outcomes',
      label: 'Tool outcomes',
      value: normalized.tool_outcome_coverage === 'complete'
        ? 'Recorded'
        : normalized.tool_outcome_coverage === 'partial'
          ? 'Partial'
          : 'Unrecorded',
      tone: normalized.tool_outcome_coverage === 'complete' ? 'ok' : 'warn',
    });
  }
  return entries;
}
