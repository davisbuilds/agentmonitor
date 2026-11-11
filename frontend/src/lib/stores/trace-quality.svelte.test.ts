import { describe, it, expect, beforeEach, vi } from 'vitest';

const fetchTraceQualityTrace = vi.fn();
const fetchTraceQualityObservations = vi.fn();
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchTraceQualityTrace: (...args: unknown[]) => fetchTraceQualityTrace(...args),
  fetchTraceQualityObservations: (...args: unknown[]) => fetchTraceQualityObservations(...args),
}));

let store: typeof import('./trace-quality.svelte');
beforeEach(async () => {
  vi.resetModules();
  fetchTraceQualityTrace.mockReset();
  fetchTraceQualityObservations.mockReset().mockResolvedValue({ tree: [] });
  store = await import('./trace-quality.svelte');
});

describe('trace detail', () => {
  it('a selection cleared while its detail loads stays cleared when the detail lands', async () => {
    let land!: (value: unknown) => void;
    fetchTraceQualityTrace.mockReturnValueOnce(new Promise(resolve => { land = resolve; }));
    const { traceQuality } = store;

    const loading = traceQuality.loadDetail('trace-x');
    expect(traceQuality.detailLoading).toBe(true);
    traceQuality.clearSelection();
    land({ trace: { id: 'trace-x' } });
    await loading;

    expect(traceQuality.detail).toBeNull();
    expect(traceQuality.detailLoading).toBe(false);
  });
});
