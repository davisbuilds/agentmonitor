import { describe, it, expect, vi } from 'vitest';
import { parseTimestamp, formatCost, formatNumber, formatDuration, formatDateRange } from './format';

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

  it('promotes a value that rounds up to the next unit', () => {
    expect(formatNumber(999_949)).toBe('999.9K');
    expect(formatNumber(999_950)).toBe('1.0M');
    expect(formatNumber(999_950_000)).toBe('1.0B');
  });
});

describe('formatDuration', () => {
  it('renders ms below a second and seconds above', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1_500)).toBe('1.5s');
  });
});

describe('formatDateRange — cost window labels', () => {
  const now = new Date(2026, 9, 15, 12, 0);

  it('names a range in the current year by month and day', () => {
    expect(formatDateRange('2026-09-01', '2026-09-30', now)).toBe('Sep 1 – Sep 30');
    expect(formatDateRange('2026-09-16', '2026-10-15', now)).toBe('Sep 16 – Oct 15');
  });

  it('names a single day once', () => {
    expect(formatDateRange('2026-10-15', '2026-10-15', now)).toBe('Oct 15');
  });

  it('adds the year when the range leaves the current year', () => {
    expect(formatDateRange('2025-12-20', '2026-01-10', now)).toBe('Dec 20, 2025 – Jan 10, 2026');
    expect(formatDateRange('2025-03-01', '2025-03-31', now)).toBe('Mar 1, 2025 – Mar 31, 2025');
  });

  it('reads the dates as calendar days in any time zone', () => {
    // West of UTC, a UTC midnight shown in local time is the day before.
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      expect(formatDateRange('2026-09-01', '2026-09-01', now)).toBe('Sep 1');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
