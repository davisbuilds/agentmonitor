import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Insight, InsightGenerationStatus } from '../api/client';

const fetchInsights = vi.fn();
const generateInsight = vi.fn();
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchInsights: (...args: unknown[]) => fetchInsights(...args),
  generateInsight: (...args: unknown[]) => generateInsight(...args),
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

// Only the fields the store reads; the rest of the row is irrelevant here.
const savedInsight = { id: 7, kind: 'overview', title: 'Saved under an earlier key' } as Insight;

// Module singleton on `$state`: reset per test so availability starts unknown.
let store: typeof import('./insights.svelte');
beforeEach(async () => {
  vi.resetModules();
  fetchInsights.mockReset();
  generateInsight.mockReset();
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

describe('insights saved while no provider key is configured', () => {
  it('stays available for saved insights after every key is removed', async () => {
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.loadAvailability();
    expect(store.insights.availability).toBe(true);
  });

  it('stays available when the filters select none of the saved insights', async () => {
    fetchInsights.mockResolvedValueOnce({ data: [savedInsight], generation: generation({}) });
    await store.insights.loadAvailability();

    // e.g. a kind or date range that matches nothing saved: an empty slice,
    // not an empty table, so the view must not drop back to Overview.
    fetchInsights.mockResolvedValueOnce({ data: [], generation: generation({}) });
    await store.insights.load();
    expect(store.insights.items).toEqual([]);
    expect(store.insights.availability).toBe(true);
  });

  it('a filtered load that finds saved insights also makes the view available', async () => {
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.load();
    expect(store.insights.availability).toBe(true);
  });

  it('never posts a generation request without a key', async () => {
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.load();
    expect(store.insights.selectedProviderConfigured).toBe(false);

    await store.insights.generate();
    expect(generateInsight).not.toHaveBeenCalled();
    expect(store.insights.items).toEqual([savedInsight]);
  });

  it('still generates once the selected provider has a key', async () => {
    fetchInsights.mockResolvedValue({ data: [], generation: generation({ openai: true }) });
    await store.insights.load();
    generateInsight.mockResolvedValue({ ...savedInsight, id: 8 });

    await store.insights.generate();
    expect(generateInsight).toHaveBeenCalledTimes(1);
  });
});
