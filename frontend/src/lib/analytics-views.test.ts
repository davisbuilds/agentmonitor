import { describe, it, expect } from 'vitest';
import type { InsightGenerationStatus } from './api/client';
import {
  anyInsightProviderConfigured,
  insightsViewAvailable,
  resolveAnalyticsView,
  visibleAnalyticsViews,
} from './analytics-views';

function generation(configured: Partial<Record<'openai' | 'anthropic' | 'gemini', boolean>>): InsightGenerationStatus {
  return {
    default_provider: 'openai',
    providers: {
      openai: { configured: configured.openai ?? false, default_model: 'gpt-5-mini' },
      anthropic: { configured: configured.anthropic ?? false, default_model: 'claude-sonnet-4-5' },
      gemini: { configured: configured.gemini ?? false, default_model: 'gemini-2.5-flash' },
    },
  };
}

describe('anyInsightProviderConfigured', () => {
  it('is false when no provider has a key', () => {
    expect(anyInsightProviderConfigured(generation({}))).toBe(false);
  });

  it('is true when any one provider has a key, not only the default', () => {
    expect(anyInsightProviderConfigured(generation({ gemini: true }))).toBe(true);
    expect(anyInsightProviderConfigured(generation({ openai: true }))).toBe(true);
  });
});

describe('insightsViewAvailable', () => {
  it('offers Insights for saved insights even when no provider has a key', () => {
    expect(insightsViewAvailable(generation({}), true)).toBe(true);
  });

  it('stays unavailable with neither a key nor a saved insight', () => {
    expect(insightsViewAvailable(generation({}), false)).toBe(false);
  });

  it('offers Insights with a key whether or not anything is saved yet', () => {
    expect(insightsViewAvailable(generation({ anthropic: true }), false)).toBe(true);
    expect(insightsViewAvailable(generation({ anthropic: true }), true)).toBe(true);
  });
});

describe('visibleAnalyticsViews', () => {
  it('offers Insights only once a key is known to exist', () => {
    expect(visibleAnalyticsViews(true)).toEqual(['overview', 'usage', 'skills', 'insights', 'quality']);
    expect(visibleAnalyticsViews(false)).toEqual(['overview', 'usage', 'skills', 'quality']);
  });

  it('hides Insights while the status is loading, so the tab never flashes', () => {
    expect(visibleAnalyticsViews(null)).not.toContain('insights');
  });
});

describe('resolveAnalyticsView', () => {
  it('falls back to Overview for an Insights deep link when no key is configured', () => {
    expect(resolveAnalyticsView('insights', false)).toBe('overview');
  });

  it('waits rather than rendering or leaving Insights while the status loads', () => {
    expect(resolveAnalyticsView('insights', null)).toBeNull();
  });

  it('renders Insights when a key is configured', () => {
    expect(resolveAnalyticsView('insights', true)).toBe('insights');
  });

  it('leaves every other view alone regardless of Insights availability', () => {
    for (const view of ['overview', 'usage', 'skills', 'quality'] as const) {
      for (const availability of [true, false, null]) {
        expect(resolveAnalyticsView(view, availability)).toBe(view);
      }
    }
  });
});
