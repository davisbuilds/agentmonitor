import { describe, it, expect } from 'vitest';
import type { QuotaMonitorData, QuotaMonitorWindow } from './api/client';
import { quotaPillEntries, quotaPillLabel } from './quota-pill';

function win(used: number, minutes = 300): QuotaMonitorWindow {
  return { used_percent: used, remaining_percent: 100 - used, resets_at: null, window_minutes: minutes };
}

function row(provider: 'claude' | 'codex', extra: Partial<QuotaMonitorData> = {}): QuotaMonitorData {
  return {
    provider,
    agent_type: provider === 'claude' ? 'claude_code' : 'codex',
    status: 'available',
    source: null,
    updated_at: null,
    account_label: null,
    plan_type: null,
    limit_id: null,
    limit_name: null,
    error_message: null,
    primary: null,
    secondary: null,
    credits: null,
    ...extra,
  };
}

describe('quota pill', () => {
  it('names each provider and shows what is left of its most-used window', () => {
    const entries = quotaPillEntries([
      row('claude', { primary: win(25), secondary: win(10, 10080) }),
      row('codex', { primary: win(2), secondary: win(70, 10080) }),
    ]);
    expect(entries.map(e => [e.label, e.remainingPercent, e.tone])).toEqual([
      ['Claude', 75, 'ok'],
      ['Codex', 30, 'warn'],
    ]);
  });

  it('tones by how much is used', () => {
    const tones = [59, 60, 84, 85].map(used => quotaPillEntries([row('claude', { primary: win(used) })])[0].tone);
    expect(tones).toEqual(['ok', 'warn', 'warn', 'danger']);
  });

  it('leaves out providers without a usable snapshot', () => {
    expect(quotaPillEntries([
      row('claude', { status: 'unavailable' }),
      row('codex', { primary: null, secondary: null }),
      row('codex', { status: 'error', primary: win(10) }),
    ])).toEqual([]);
  });

  it('rounds the percentage it shows', () => {
    expect(quotaPillEntries([row('claude', { primary: win(24.6) })])[0].remainingPercent).toBe(75);
  });

  it('says what the numbers are in its accessible name', () => {
    const entries = quotaPillEntries([row('claude', { primary: win(25) }), row('codex', { primary: win(2) })]);
    expect(quotaPillLabel(entries)).toBe('Quota left: Claude 75%, Codex 98%');
    expect(quotaPillLabel([])).toBe('Provider quota');
  });
});
