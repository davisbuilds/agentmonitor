import { describe, it, expect, vi } from 'vitest';
import {
  agentColor,
  agentDisplayName,
  agentHexColor,
  formatCost,
  formatDateOnly,
  formatDateRange,
  formatDuration,
  formatModelName,
  formatNumber,
  modelSelectOptions,
  formatTimeOfDay,
  parseTimestamp,
  statusColor,
  timeAgo,
} from './format';

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

describe('formatModelName — one spelling for every model', () => {
  it('leaves a plain model ID alone', () => {
    for (const id of ['claude-opus-4-8', 'gpt-6-astra', 'gpt-5.6-sol', 'gemini-3.8-flash', 'codex-auto-review']) {
      expect(formatModelName(id)).toBe(id);
    }
  });

  it('drops routing prefixes and the long-context suffix', () => {
    expect(formatModelName('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(formatModelName('openai/gpt-6-astra')).toBe('gpt-6-astra');
    expect(formatModelName('google/gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(formatModelName('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
  });

  it('reduces a Bedrock ID to its model', () => {
    expect(formatModelName('us.anthropic.claude-opus-4-8-v1:0')).toBe('claude-opus-4-8');
    expect(formatModelName('anthropic.claude-sonnet-5-v1')).toBe('claude-sonnet-5');
  });

  it('drops a release date stamp', () => {
    expect(formatModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(formatModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
    expect(formatModelName('openai/gpt-5.4-2026-03-05')).toBe('gpt-5.4');
    // Version numbers are not dates.
    expect(formatModelName('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(formatModelName('gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
  });
});

describe('modelSelectOptions — a filter option per raw ID', () => {
  it('labels options with the display spelling', () => {
    expect(modelSelectOptions(['claude-haiku-4-5-20251001', 'gpt-6-astra'])).toEqual([
      { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5' },
      { value: 'gpt-6-astra', label: 'gpt-6-astra' },
    ]);
  });

  it('keeps the raw ID where two IDs would read the same, since they can filter differently', () => {
    expect(modelSelectOptions(['openai/gpt-5.4', 'gpt-5.4', 'gpt-6-astra'])).toEqual([
      { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4' },
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-6-astra', label: 'gpt-6-astra' },
    ]);
  });
});

// Moved from the root node:test suite, which duplicated this one.
describe('formatDateOnly', () => {
  it('keeps a UTC calendar date in a negative local offset', () => {
    vi.stubEnv('TZ', 'America/Chicago');
    try {
      expect(formatDateOnly('2026-06-30', 'en-US')).toBe('Jun 30, 2026');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('timeAgo', () => {
  it('does not go negative for recent UTC-backed SQLite timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T11:45:30.000Z'));
    try {
      expect(timeAgo('2026-04-10 11:45:00')).toBe('30s ago');
      expect(timeAgo('2026-04-10 11:44:00')).toBe('1m ago');
      expect(timeAgo('2026-04-10 09:45:00')).toBe('2h ago');
      expect(timeAgo('2026-04-08 11:45:00')).toBe('2d ago');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compact formats', () => {
  it('formats costs, large numbers and durations', () => {
    expect(formatCost(null)).toBe('$0.00');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.235)).toBe('$1.24');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1_250)).toBe('1.3K');
    expect(formatNumber(2_500_000)).toBe('2.5M');
    expect(formatNumber(999_900_000)).toBe('999.9M');
    expect(formatNumber(1_000_000_000)).toBe('1.0B');
    expect(formatNumber(2_049_100_000)).toBe('2.0B');
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1250)).toBe('1.3s');
    expect(typeof formatTimeOfDay('2026-04-10T11:45:00Z')).toBe('string');
  });
});

describe('agent and status styling', () => {
  it('maps agents to their colors and names', () => {
    expect(agentColor('claude_code')).toBe('text-claude');
    expect(agentColor('codex')).toBe('text-codex');
    expect(agentColor('other')).toBe('text-accent');
    expect(agentHexColor('claude')).toBe('var(--color-claude)');
    expect(agentHexColor('codex')).toBe('var(--color-codex)');
    expect(agentHexColor('other')).toBe('var(--color-accent)');
    expect(agentDisplayName('claude')).toBe('Claude');
    expect(agentDisplayName('claude_code')).toBe('Claude');
    expect(agentDisplayName('codex')).toBe('Codex');
    expect(agentDisplayName('other')).toBe('Assistant');
  });

  it('maps statuses to their dot colors', () => {
    expect(statusColor('active')).toBe('bg-ok');
    expect(statusColor('idle')).toBe('bg-warn');
    expect(statusColor('ended')).toBe('bg-line-strong');
    expect(statusColor('error')).toBe('bg-danger');
    expect(statusColor('unknown')).toBe('bg-line-strong');
  });
});
