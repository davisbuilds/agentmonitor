import { describe, expect, it } from 'vitest';
import {
  formatTraceCost,
  formatTraceTokens,
  sessionTraceCoverageEntries,
  traceCoveragePills,
} from './trace-coverage';

const zeroAgg = {
  total_tokens_in: 0,
  total_tokens_out: 0,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  total_cost_usd: 0,
};

describe('trace coverage formatting', () => {
  it('distinguishes measured zero usage from unavailable usage', () => {
    expect(formatTraceTokens(zeroAgg, { usage_coverage: 'observed_zero', has_token_usage: true })).toBe('0');
    expect(formatTraceTokens(zeroAgg, { usage_coverage: 'unavailable', has_token_usage: false })).toBe('—');

    const zeroPills = traceCoveragePills({
      usage_coverage: 'observed_zero',
      cost_coverage: 'priced',
      cost_provenance: 'estimated',
      timestamp_coverage: 'exact',
      tool_outcome_coverage: 'not_applicable',
    });
    expect(zeroPills.find(p => p.key === 'usage')?.label).toBe('Usage 0 (measured)');
    expect(zeroPills.find(p => p.key === 'cost')?.label).toBe('Cost (estimated)');

    const unavailablePills = traceCoveragePills({
      usage_coverage: 'unavailable',
      cost_coverage: 'unavailable',
      cost_provenance: 'unavailable',
      timestamp_coverage: 'unavailable',
      tool_outcome_coverage: 'unrecorded',
    });
    expect(unavailablePills.find(p => p.key === 'usage')?.label).toBe('Usage unavailable');
    expect(unavailablePills.find(p => p.key === 'cost')?.label).toBe('Cost unavailable');
    expect(unavailablePills.find(p => p.key === 'timestamps')?.label).toBe('Timestamps unavailable');
    expect(unavailablePills.find(p => p.key === 'outcomes')?.label).toBe('Tool outcomes unrecorded');
  });

  it('surfaces unpriced, partial, and unavailable cost without fabricating $0', () => {
    expect(formatTraceCost(0, { cost_coverage: 'unavailable' })).toBe('—');
    expect(formatTraceCost(0, { cost_coverage: 'unpriced' })).toBe('Unpriced');
    expect(formatTraceCost(0, { cost_coverage: 'unpriced' }, { compact: true })).toBe('unpriced');
    expect(formatTraceCost(1.5, { cost_coverage: 'partial' })).toBe('$1.50 (partial)');
    expect(formatTraceCost(1.5, { cost_coverage: 'partial' }, { compact: true })).toBe('$1.50*');
    expect(formatTraceCost(0, { cost_coverage: 'priced', cost_provenance: 'estimated' })).toBe('$0.00');
  });

  it('produces detail entries for SessionCoverage popover', () => {
    const entries = sessionTraceCoverageEntries({
      usage_coverage: 'observed',
      cost_coverage: 'partial',
      cost_provenance: 'estimated',
      timestamp_coverage: 'approximate',
      tool_outcome_coverage: 'partial',
    });
    expect(entries).toEqual([
      { key: 'usage', label: 'Token usage', value: 'Observed', tone: 'ok' },
      { key: 'cost', label: 'Cost', value: 'Partial (estimated)', tone: 'warn' },
      { key: 'timestamps', label: 'Timestamps', value: 'Approximate', tone: 'warn' },
      { key: 'tool_outcomes', label: 'Tool outcomes', value: 'Partial', tone: 'warn' },
    ]);
    expect(sessionTraceCoverageEntries(null)).toEqual([]);
  });
});
