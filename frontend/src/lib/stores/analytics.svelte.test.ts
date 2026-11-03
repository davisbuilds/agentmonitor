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

describe('change markers', () => {
  // The timelines read markers without an error notice, so a slice's markers
  // must never be drawn on another slice's charts.
  const markersFor = (project: string) => ({
    markers: [{ kind: 'instructions', date: '2026-03-03', at: '2026-03-03T10:00:00Z', project, files: ['AGENTS.md'], commits: [] }],
  });

  function answerMarkers(answer: (url: URL) => Promise<Response>): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      requested.push(url);
      return answer(url);
    }));
  }
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response;
  const failed = { ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' } as unknown as Response;

  it("drops a slice's markers when the next slice's markers fail to load", async () => {
    answerMarkers(async url => ok(markersFor(url.searchParams.get('project') ?? '')));
    analyticsFilters.setProject('alpha');
    await analytics.fetchChangeMarkers();
    expect(analytics.changeMarkers).toEqual(markersFor('alpha'));

    answerMarkers(async () => failed);
    analyticsFilters.setProject('beta');
    await analytics.fetchChangeMarkers();
    expect(analytics.errors.markers).not.toBeNull();
    expect(analytics.changeMarkers).toBeNull();
  });

  it("hides a slice's markers while another slice's load, but keeps them through a refresh of the same slice", async () => {
    answerMarkers(async url => ok(markersFor(url.searchParams.get('project') ?? '')));
    analyticsFilters.setProject('alpha');
    await analytics.fetchChangeMarkers();

    let release: (response: Response) => void = () => {};
    answerMarkers(() => new Promise(resolve => { release = resolve; }));
    const refresh = analytics.fetchChangeMarkers();
    expect(analytics.changeMarkers).toEqual(markersFor('alpha'));
    release(ok(markersFor('alpha')));
    await refresh;

    analyticsFilters.setProject('beta');
    const next = analytics.fetchChangeMarkers();
    expect(analytics.changeMarkers).toBeNull();
    release(ok(markersFor('beta')));
    await next;
    expect(analytics.changeMarkers).toEqual(markersFor('beta'));
  });
});
