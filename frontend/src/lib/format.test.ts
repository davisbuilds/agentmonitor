import { describe, it, expect } from 'vitest';
import { parseTimestamp, formatCost, formatNumber, formatDuration } from './format';

describe('parseTimestamp — timezone normalization', () => {
  it('treats a space-separated SQLite timestamp as UTC', () => {
    // "YYYY-MM-DD HH:MM:SS" (no T, no zone) is a SQLite datetime; it must be
    // read as UTC, not local, or every card time shifts by the offset.
    expect(parseTimestamp('2026-09-11 12:00:00').toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('treats a naive ISO timestamp (T, no zone) as UTC', () => {
    expect(parseTimestamp('2026-09-11T12:00:00').toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('respects an explicit Z', () => {
    expect(parseTimestamp('2026-09-11T12:00:00Z').toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('respects an explicit numeric offset without appending Z', () => {
    expect(parseTimestamp('2026-09-11T12:00:00+02:00').toISOString()).toBe('2026-09-11T10:00:00.000Z');
  });
});

describe('formatCost', () => {
  it('renders zero and nullish as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(null)).toBe('$0.00');
    expect(formatCost(undefined)).toBe('$0.00');
  });

  it('renders sub-cent amounts as <$0.01', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
  });

  it('renders normal amounts to two decimals', () => {
    expect(formatCost(12.3)).toBe('$12.30');
  });
});

describe('formatNumber', () => {
  it('abbreviates at K/M/B thresholds', () => {
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1_500)).toBe('1.5K');
    expect(formatNumber(2_000_000)).toBe('2.0M');
    expect(formatNumber(3_000_000_000)).toBe('3.0B');
  });
});

describe('formatDuration', () => {
  it('renders ms below a second and seconds above', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1_500)).toBe('1.5s');
  });
});
