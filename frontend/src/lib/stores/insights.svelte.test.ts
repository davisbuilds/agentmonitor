import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Insight, InsightGenerationStatus } from '../api/client';

const fetchInsights = vi.fn();
const generateInsight = vi.fn();
const deleteInsight = vi.fn();
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchInsights: (...args: unknown[]) => fetchInsights(...args),
  generateInsight: (...args: unknown[]) => generateInsight(...args),
  deleteInsight: (...args: unknown[]) => deleteInsight(...args),
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

// The unfiltered availability read asks for one row; list loads send filters.
const isAvailabilityRead = (params: unknown) => (params as { limit?: number }).limit === 1;

// Module singleton on `$state`: reset per test so availability starts unknown.
let store: typeof import('./insights.svelte');
beforeEach(async () => {
  vi.resetModules();
  fetchInsights.mockReset();
  generateInsight.mockReset();
  deleteInsight.mockReset();
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
    fetchInsights.mockImplementation(async (params: unknown) => ({
      data: isAvailabilityRead(params) ? [savedInsight] : [],
      generation: generation({}),
    }));
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

describe('insights availability once saved insights are gone', () => {
  it('drops the view after the final saved insight is deleted without a key', async () => {
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.load();
    expect(store.insights.availability).toBe(true);

    deleteInsight.mockResolvedValue({ removed: true });
    fetchInsights.mockResolvedValue({ data: [], generation: generation({}) });
    await store.insights.removeSelected();
    expect(store.insights.items).toEqual([]);
    expect(store.insights.availability).toBe(false);
    expect(fetchInsights).toHaveBeenLastCalledWith({ limit: 1 });
  });

  it('keeps the view after deleting the last row of a slice while others are saved', async () => {
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.load();

    deleteInsight.mockResolvedValue({ removed: true });
    fetchInsights.mockResolvedValue({ data: [{ ...savedInsight, id: 9 }], generation: generation({}) });
    await store.insights.removeSelected();
    expect(store.insights.items).toEqual([]);
    expect(store.insights.availability).toBe(true);
  });

  it('keeps the view when a delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.load();
    fetchInsights.mockClear();

    deleteInsight.mockRejectedValue(new Error('boom'));
    await store.insights.removeSelected();
    expect(fetchInsights).not.toHaveBeenCalled();
    expect(store.insights.items).toEqual([savedInsight]);
    expect(store.insights.availability).toBe(true);
  });

  it('drops the view when a refresh finds the final saved insight removed elsewhere', async () => {
    fetchInsights.mockResolvedValue({ data: [savedInsight], generation: generation({}) });
    await store.insights.loadAvailability();
    await store.insights.load();
    expect(store.insights.availability).toBe(true);

    // Removed outside this page (another tab, the CLI); then Refresh.
    fetchInsights.mockResolvedValue({ data: [], generation: generation({}) });
    await store.insights.load();
    expect(store.insights.availability).toBe(false);
    expect(fetchInsights).toHaveBeenLastCalledWith({ limit: 1 });
  });

  it('with a key, an empty slice needs no availability read', async () => {
    fetchInsights.mockResolvedValue({ data: [], generation: generation({ openai: true }) });
    await store.insights.load();
    expect(fetchInsights).toHaveBeenCalledTimes(1);
    expect(fetchInsights).not.toHaveBeenCalledWith({ limit: 1 });
    expect(store.insights.availability).toBe(true);
  });

  it('a stale availability read cannot overwrite a newer one', async () => {
    let resolveStale!: (value: unknown) => void;
    fetchInsights.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }));
    const stale = store.insights.loadAvailability();

    fetchInsights.mockResolvedValueOnce({ data: [], generation: generation({}) });
    await store.insights.loadAvailability();
    expect(store.insights.availability).toBe(false);

    resolveStale({ data: [savedInsight], generation: generation({}) });
    await stale;
    expect(store.insights.availability).toBe(false);
  });

  it('a stale availability read cannot hide rows a later list load found', async () => {
    let resolveStale!: (value: unknown) => void;
    fetchInsights.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }));
    const stale = store.insights.loadAvailability();

    fetchInsights.mockResolvedValueOnce({ data: [savedInsight], generation: generation({}) });
    await store.insights.load();
    expect(store.insights.availability).toBe(true);

    resolveStale({ data: [], generation: generation({}) });
    await stale;
    expect(store.insights.availability).toBe(true);
  });

  it('a failed recheck keeps the view a saved row already proved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchInsights.mockResolvedValueOnce({ data: [savedInsight], generation: generation({}) });
    await store.insights.loadAvailability();

    // An empty filtered slice rechecks unfiltered; a transient failure there
    // is no evidence that nothing is saved.
    fetchInsights.mockResolvedValueOnce({ data: [], generation: generation({}) });
    fetchInsights.mockRejectedValueOnce(new Error('boom'));
    await store.insights.load();
    expect(fetchInsights).toHaveBeenLastCalledWith({ limit: 1 });
    expect(store.insights.availability).toBe(true);
  });

  it('a stale availability read cannot hide a key a later list load found', async () => {
    let resolveStale!: (value: unknown) => void;
    fetchInsights.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }));
    const stale = store.insights.loadAvailability();

    fetchInsights.mockResolvedValueOnce({ data: [], generation: generation({ openai: true }) });
    await store.insights.load();
    expect(store.insights.availability).toBe(true);

    resolveStale({ data: [], generation: generation({}) });
    await stale;
    expect(store.insights.availability).toBe(true);
  });

  it('a stale failed availability read is ignored after a later list load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectStale!: (err: unknown) => void;
    fetchInsights.mockImplementationOnce(() => new Promise((_, reject) => { rejectStale = reject; }));
    const stale = store.insights.loadAvailability();

    fetchInsights.mockResolvedValueOnce({ data: [], generation: generation({ openai: true }) });
    await store.insights.load();

    rejectStale(new Error('boom'));
    await stale;
    expect(consoleError).not.toHaveBeenCalled();
    expect(store.insights.availability).toBe(true);
  });
});
