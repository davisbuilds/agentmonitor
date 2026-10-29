import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Every request is answered with an empty-but-valid body; the tests assert which
// endpoints each Analytics sub-view asks for, not what it renders.
const requested: URL[] = [];

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requested.push(new URL(String(input), 'http://localhost'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [], coverage: null, consultations: null }),
      text: async () => '',
    } as unknown as Response;
  }));
}

function paths(): string[] {
  return requested.map(url => url.pathname);
}

let analytics: typeof import('./analytics.svelte')['analytics'];
let analyticsFilters: typeof import('./analytics-filters.svelte')['analyticsFilters'];

beforeEach(async () => {
  vi.resetModules();
  requested.length = 0;
  stubFetch();
  ({ analytics } = await import('./analytics.svelte'));
  ({ analyticsFilters } = await import('./analytics-filters.svelte'));
});

afterEach(() => {
  analytics.dispose();
  vi.unstubAllGlobals();
});

describe('Overview requests', () => {
  it('loads activity panels but not the skill or message-count top-session reads', async () => {
    await analytics.initialize();
    // Control: Overview did fetch, so the absences below are not a silent no-op.
    expect(paths()).toContain('/api/v2/analytics/summary');
    expect(paths()).toContain('/api/v2/analytics/tools');
    expect(paths()).not.toContain('/api/v2/analytics/top-sessions');
    expect(paths()).not.toContain('/api/v2/analytics/skills/daily');
    expect(paths()).not.toContain('/api/v2/analytics/skills/health');
  });
});

describe('Skills requests', () => {
  it('loads daily invocation volume alongside consultation evidence', async () => {
    await analytics.initializeSkills();
    expect(paths()).toContain('/api/v2/analytics/skills/daily');
    expect(paths()).toContain('/api/v2/analytics/skills/health');
    expect(paths()).not.toContain('/api/v2/analytics/summary');
  });

  it('refetches both with the new shared filter when it changes', async () => {
    await analytics.initializeSkills();
    requested.length = 0;

    analyticsFilters.setProject('alpha');
    await vi.waitFor(() => {
      expect(paths()).toEqual(expect.arrayContaining([
        '/api/v2/analytics/skills/daily',
        '/api/v2/analytics/skills/health',
      ]));
    });
    for (const url of requested) {
      expect(url.searchParams.get('project')).toBe('alpha');
    }
  });
});

describe('the shared agent filter', () => {
  it("holds Claude under the option list's spelling when a drill-down passes the event spelling", () => {
    // Usage's By Agent rows name Claude `claude_code`; the filter options say `claude`.
    analyticsFilters.setAgent('claude_code');
    expect(analyticsFilters.agent).toBe('claude');
  });
});
