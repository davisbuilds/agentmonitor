import { describe, expect, it } from 'vitest';
import { formatHours, formatRate, percentChange, pointChange } from './overview-headlines';

describe('overview headline changes', () => {
  it('reports percent change, toned only where up is worse', () => {
    expect(percentChange(150, 100)).toEqual({ value: '+50%', tone: 'muted' });
    expect(percentChange(150, 100, 'up-is-bad')).toEqual({ value: '+50%', tone: 'danger' });
    expect(percentChange(80, 100, 'up-is-bad')).toEqual({ value: '-20%', tone: 'ok' });
  });

  it('says nothing without a period before to compare with', () => {
    expect(percentChange(10, null)).toBeNull();
    expect(percentChange(10, 0)).toBeNull();
    expect(pointChange(0.02, null)).toBeNull();
  });

  it('moves a rate in percentage points', () => {
    expect(pointChange(0.0295, 0.0206)).toEqual({ value: '+0.9 pt', tone: 'danger' });
    expect(pointChange(0.02, 0.02)).toEqual({ value: '0.0 pt', tone: 'muted' });
  });

  it('formats rates and hours', () => {
    expect([formatRate(0.029518), formatRate(null)]).toEqual(['3.0%', '—']);
    expect([formatHours(4.33), formatHours(129.4)]).toEqual(['4.3 h', '129 h']);
  });
});
