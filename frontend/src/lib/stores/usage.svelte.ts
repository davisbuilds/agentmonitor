import {
  fetchUsageOverview,
  fetchUsageFacets,
  type UsageSummary,
  type UsageCoverage,
  type UsageDailyPoint,
  type UsageProjectBreakdown,
  type UsageModelBreakdown,
  type UsageModelDailyPoint,
  type UsageTierBreakdown,
  type UsageAgentBreakdown,
  type UsageTopSessionRow,
} from '../api/client';
import { navigateToSession } from './router.svelte';
import { analyticsFilters } from './analytics-filters.svelte';
import {
  buildUsageCsv,
  downloadUsageCsv,
} from '../usage-state';

type PanelKey =
  | 'summary'
  | 'daily'
  | 'projects'
  | 'models'
  | 'modelsDaily'
  | 'tiers'
  | 'agents'
  | 'topSessions';

type FiltersSnapshot = {
  from: string;
  to: string;
  project: string;
  agent: string;
  model: string;
  provider: string;
  tier: string;
};

class UsageStore {
  private readonly versions: Record<PanelKey, number> = {
    summary: 0,
    daily: 0,
    projects: 0,
    models: 0,
    modelsDaily: 0,
    tiers: 0,
    agents: 0,
    topSessions: 0,
  };
  private initialized = false;
  private unsubscribe: (() => void) | null = null;
  private filterOptionsVersion = 0;
  private readonly controllers: Record<PanelKey, AbortController | null> = {
    summary: null,
    daily: null,
    projects: null,
    models: null,
    modelsDaily: null,
    tiers: null,
    agents: null,
    topSessions: null,
  };
  private filterOptionsController: AbortController | null = null;

  // Shared + Usage-specialized filters live in the consolidated analytics filter
  // store; this store reads them and refetches when they change.
  get from(): string { return analyticsFilters.from; }
  get to(): string { return analyticsFilters.to; }
  get project(): string { return analyticsFilters.project; }
  get agent(): string { return analyticsFilters.agent; }
  get model(): string { return analyticsFilters.model; }
  get provider(): string { return analyticsFilters.provider; }
  get tier(): string { return analyticsFilters.tier; }

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);
  modelOptions = $state<string[]>([]);
  providerOptions = $state<string[]>([]);
  tierOptions = $state<string[]>([]);

  summary = $state<UsageSummary | null>(null);
  daily = $state<UsageDailyPoint[]>([]);
  projects = $state<UsageProjectBreakdown[]>([]);
  models = $state<UsageModelBreakdown[]>([]);
  modelsDaily = $state<UsageModelDailyPoint[]>([]);
  tiers = $state<UsageTierBreakdown[]>([]);
  agents = $state<UsageAgentBreakdown[]>([]);
  topSessions = $state<UsageTopSessionRow[]>([]);

  coverage = $state<UsageCoverage | null>(null);

  loading = $state<Record<PanelKey, boolean>>({
    summary: false,
    daily: false,
    projects: false,
    models: false,
    modelsDaily: false,
    tiers: false,
    agents: false,
    topSessions: false,
  });

  errors = $state<Record<PanelKey, string | null>>({
    summary: null,
    daily: null,
    projects: null,
    models: null,
    modelsDaily: null,
    tiers: null,
    agents: null,
    topSessions: null,
  });

  get filters(): FiltersSnapshot {
    return {
      from: this.from,
      to: this.to,
      project: this.project,
      agent: this.agent,
      model: this.model,
      provider: this.provider,
      tier: this.tier,
    };
  }

  get defaultFrom(): string {
    return analyticsFilters.defaultFrom;
  }

  get defaultTo(): string {
    return analyticsFilters.defaultTo;
  }

  get hasActiveFilters(): boolean {
    return (
      analyticsFilters.hasActiveSharedFilters
      || this.model !== ''
      || this.provider !== ''
      || this.tier !== ''
    );
  }

  get anyLoading(): boolean {
    return Object.values(this.loading).some(Boolean);
  }

  get queryParams(): Record<string, string> {
    const params: Record<string, string> = {
      date_from: this.from,
      date_to: this.to,
    };
    if (this.project) params.project = this.project;
    if (this.agent) params.agent = this.agent;
    if (this.model) params.model = this.model;
    if (this.provider) params.provider = this.provider;
    if (this.tier) params.tier = this.tier;
    return params;
  }

  async initialize(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = analyticsFilters.subscribe(() => {
        void this.refreshUsage();
      });
    }
    await analyticsFilters.initialize();

    if (!this.initialized) {
      await this.fetchFilterOptions();
      this.initialized = true;
    }

    await this.fetchAll();
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.abortAll();
  }

  /**
   * One request, not eight. Every panel is a rollup of the same rows and each
   * per-panel response carried an identical `coverage` block, so fanning out
   * made the server scan (and recompute coverage) eight times over — and since
   * it is synchronous, the requests serialized rather than overlapping.
   */
  async fetchAll(): Promise<void> {
    const keys: PanelKey[] = [
      'summary', 'daily', 'projects', 'models', 'modelsDaily', 'tiers', 'agents', 'topSessions',
    ];
    const versions = new Map(keys.map(key => [key, ++this.versions[key]]));
    const stale = (): boolean => keys.some(key => versions.get(key) !== this.versions[key]);

    // One request backs every panel, so the same controller is registered under
    // each key: abortAll()/dispose() and any later per-panel nextSignal() all
    // still cancel it.
    const controller = new AbortController();
    for (const key of keys) {
      this.controllers[key]?.abort();
      this.controllers[key] = controller;
      this.loading[key] = true;
      this.errors[key] = null;
    }

    try {
      const overview = await fetchUsageOverview(this.queryParams, { signal: controller.signal });
      if (stale()) return;

      this.summary = overview.summary;
      this.daily = overview.daily;
      this.projects = overview.projects;
      this.models = overview.models;
      this.modelsDaily = overview.models_daily;
      this.tiers = overview.tiers;
      this.agents = overview.agents;
      this.topSessions = overview.top_sessions;
      this.coverage = overview.coverage;
    } catch (err) {
      if (isAbortError(err) || stale()) return;
      console.error('Failed to load usage overview:', err);
      for (const key of keys) this.errors[key] = 'Failed to load usage data.';
    } finally {
      if (!stale()) {
        for (const key of keys) this.loading[key] = false;
      }
    }
  }









  // Filter mutations delegate to the shared store, which syncs the hash and
  // notifies subscribers (this store's refreshUsage) — no direct fetch here.
  async setDateRange(from: string, to: string): Promise<void> {
    analyticsFilters.setDateRange(from, to);
  }

  async applyQuickRange(days: number): Promise<void> {
    analyticsFilters.applyQuickRange(days);
  }

  async setProject(project: string): Promise<void> {
    analyticsFilters.setProject(project);
  }

  async setAgent(agent: string): Promise<void> {
    analyticsFilters.setAgent(agent);
  }

  async setModel(model: string): Promise<void> {
    analyticsFilters.setModel(model);
  }

  async setProvider(provider: string): Promise<void> {
    analyticsFilters.setProvider(provider);
  }

  async setTier(tier: string): Promise<void> {
    analyticsFilters.setTier(tier);
  }

  async clearAllFilters(): Promise<void> {
    analyticsFilters.batch(() => {
      analyticsFilters.clearSharedFilters();
      analyticsFilters.setModel('');
      analyticsFilters.setProvider('');
      analyticsFilters.setTier('');
    });
  }

  openSession(sessionId: string): void {
    navigateToSession(sessionId);
  }

  exportCsv(): void {
    const csv = buildUsageCsv({
      generatedAt: new Date().toISOString(),
      filters: this.filters,
      summary: this.summary,
      daily: this.daily,
      projects: this.projects,
      models: this.models,
      tiers: this.tiers,
      agents: this.agents,
      topSessions: this.topSessions,
    });
    downloadUsageCsv(`agentmonitor-usage-${this.from}-to-${this.to}.csv`, csv);
  }

  private async refreshUsage(): Promise<void> {
    await Promise.all([
      this.fetchFilterOptions(),
      this.fetchAll(),
    ]);
  }

  private async fetchFilterOptions(): Promise<void> {
    const version = ++this.filterOptionsVersion;
    this.filterOptionsController?.abort();
    const controller = new AbortController();
    this.filterOptionsController = controller;

    try {
      // One DISTINCT query server-side. This was five full rollup requests — each
      // scanning and pricing-classifying every usage row — to read off five lists
      // of distinct strings. The server applies the same self-excluding facet
      // scoping these five calls used to encode in their query params.
      const facets = await fetchUsageFacets(this.queryParams, { signal: controller.signal });

      if (version !== this.filterOptionsVersion) return;

      this.projectOptions = withSelectedOption(facets.projects, this.project);
      this.agentOptions = withSelectedOption(facets.agents, this.agent);
      this.modelOptions = withSelectedOption(facets.models, this.model);
      this.providerOptions = withSelectedOption(facets.providers, this.provider);
      this.tierOptions = withSelectedOption(facets.tiers, this.tier);
    } catch (err) {
      if (isAbortError(err)) return;
      // Usage can still load without refreshed filter options.
    } finally {
      if (this.filterOptionsController === controller) {
        this.filterOptionsController = null;
      }
    }
  }


  private nextSignal(key: PanelKey): AbortSignal {
    this.controllers[key]?.abort();
    const controller = new AbortController();
    this.controllers[key] = controller;
    return controller.signal;
  }

  private abortAll(): void {
    for (const key of Object.keys(this.controllers) as PanelKey[]) {
      this.controllers[key]?.abort();
      this.controllers[key] = null;
    }
    this.filterOptionsController?.abort();
    this.filterOptionsController = null;
  }

}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function withSelectedOption(options: string[], selected: string): string[] {
  const unique = new Set(options.filter(Boolean));
  if (selected) unique.add(selected);
  return [...unique].sort((a, b) => a.localeCompare(b));
}

export const usage = new UsageStore();
