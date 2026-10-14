import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InsightGenerationStatus } from '../api/client';

const fetchInsights = vi.fn();
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchInsights: (...args: unknown[]) => fetchInsights(...args),
}));

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

// Module singleton on `$state`: reset per test so availability starts unknown.
let store: typeof import('./insights.svelte');
beforeEach(async () => {
  vi.resetModules();
  fetchInsights.mockReset();
  store = await import('./insights.svelte');
});

describe('insights availability', () => {
  it('is unknown until the status has loaded', () => {
    expect(store.insights.availability).toBeNull();
  });

  it('is false when no provider has a key', async () => {
    fetchInsights.mockResolvedValue({ data: [], generation: generation({}) });
    await store.insights.loadAvailability();
    expect(store.insights.availability).toBe(false);
  });

  it('is true when any provider has a key', async () => {
    fetchInsights.mockResolvedValue({ data: [], generation: generation({ anthropic: true }) });
    await store.insights.loadAvailability();
    expect(store.insights.availability).toBe(true);
  });

  it('asks for a single row: only the status is needed', async () => {
    fetchInsights.mockResolvedValue({ data: [], generation: generation({}) });
    await store.insights.loadAvailability();
    expect(fetchInsights).toHaveBeenCalledWith({ limit: 1 });
  });

  it('treats a failed status read as unavailable rather than waiting forever', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchInsights.mockRejectedValue(new Error('boom'));
    await store.insights.loadAvailability();
    expect(store.insights.availability).toBe(false);
  });

  it('a full list load also refreshes availability', async () => {
    fetchInsights.mockResolvedValue({ data: [], generation: generation({ gemini: true }) });
    await store.insights.load();
    expect(store.insights.availability).toBe(true);
  });
});
