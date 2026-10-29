import { formatNumber } from './format';

export interface TokenBuckets {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/**
 * Every token a row processed: uncached input, output, cache reads and writes,
 * as the daily chart and Monitor count them. One definition for every Usage row.
 */
export function usageTokenTotal(row: TokenBuckets): number {
  return row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
}

/** The four buckets behind a total, for a hover readout. */
export function usageTokenSplit(row: TokenBuckets): string {
  return [
    `${formatNumber(row.input_tokens)} input`,
    `${formatNumber(row.output_tokens)} output`,
    `${formatNumber(row.cache_read_tokens)} cache read`,
    `${formatNumber(row.cache_write_tokens)} cache write`,
  ].join(' · ');
}
