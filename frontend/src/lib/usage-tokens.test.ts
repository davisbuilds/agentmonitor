import { describe, expect, it } from 'vitest';
import { usageTokenSplit, usageTokenTotal } from './usage-tokens';

const row = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 1_000, cache_write_tokens: 200 };

describe('usage token totals', () => {
  it('count every bucket, so model, project, tier and agent rows agree', () => {
    expect(usageTokenTotal(row)).toBe(1_215);
  });

  it('name each bucket behind the total', () => {
    expect(usageTokenSplit(row)).toBe('10 input · 5 output · 1.0K cache read · 200 cache write');
  });
});
