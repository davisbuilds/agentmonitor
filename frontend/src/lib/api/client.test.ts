// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCostData, type UsageOverview } from './client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchCostData', () => {
  it('loads every Monitor cost panel from one Usage overview request', async () => {
    const overview = {
      daily: [{ date: '2026-09-11', cost_usd: 1.25 }],
      projects: [{ project: 'agentmonitor', cost_usd: 1.1, session_count: 3, usage_events: 8 }],
      models: [{ model: 'gpt-6-astra', cost_usd: 0.9 }],
    } as UsageOverview;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(overview), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchMock;

    const result = await fetchCostData({ since: '2026-09-01T00:00:00.000Z' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/usage/overview?date_from=2026-09-01T00%3A00%3A00.000Z', {});
    expect(result).toEqual({
      timeline: [{ date: '2026-09-11', cost: 1.25 }],
      by_project: [{ project: 'agentmonitor', cost: 1.1, session_count: 3, event_count: 8 }],
      by_model: [{ model: 'gpt-6-astra', cost: 0.9 }],
    });
  });
});
