import { describe, expect, it } from 'vitest';
import { sparklineSegments } from './sparkline';

describe('sparkline segments', () => {
  it('spans the width, with the peak at the top and zero at the baseline', () => {
    expect(sparklineSegments([0, 5, 10])).toEqual(['0.00,27.00 50.00,14.00 100.00,1.00']);
  });

  it('breaks the line at a day with no value', () => {
    expect(sparklineSegments([2, null, 2, 1])).toEqual(['0.00,1.00', '66.67,1.00 100.00,14.00']);
  });

  it('lies flat on the baseline when every day is zero', () => {
    expect(sparklineSegments([0, 0])).toEqual(['0.00,27.00 100.00,27.00']);
  });
});
