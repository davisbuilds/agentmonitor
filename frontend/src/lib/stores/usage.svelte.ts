import {
  fetchUsageSummary,
  fetchUsageDaily,
  fetchUsageProjects,
  fetchUsageModels,
  fetchUsageTiers,
  fetchUsageAgents,
  fetchUsageTopSessions,
  type UsageSummary,
  type UsageCoverage,
  type UsageDailyPoint,
  type UsageProjectBreakdown,
  type UsageModelBreakdown,
  type UsageTierBreakdown,
  type UsageAgentBreakdown,
  type UsageTopSessionRow,
} from '../api/client';
import { navigateToSession } from './router.svelte';
import {
  createDefaultUsageFilters,
  buildUsageHash,
  parseUsageHash,
  buildUsageCsv,
  downloadUsageCsv,
} from '../usage-state';

type PanelKey =
  | 'summary'
  | 'daily'
  | 'projects'
  | 'models'
  | 'tiers'
  | 'agents'
  | 'topSessions';

type UsageFacetKey = 'project' | 'agent' | 'model' | 'provider' | 'tier';

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
  private readonly defaults = createDefaultUsageFilters();
  private readonly versions: Record<PanelKey, number> = {
    summary: 0,
    daily: 0,
    projects: 0,
    models: 0,
    tiers: 0,
    agents: 0,
    topSessions: 0,
  };
  private initialized = false;
  private hashListenerAttached = false;
  private filterOptionsVersion = 0;
  private readonly controllers: Record<PanelKey, AbortController | null> = {
    summary: null,
    daily: null,
    projects: null,
    models: null,
    tiers: null,
    agents: null,
    topSessions: null,
  };
  private filterOptionsController: AbortController | null = null;

  from = $state(this.defaults.from);
  to = $state(this.defaults.to);
  project = $state('');
  agent = $state('');
  model = $state('');
  provider = $state('');
  tier = $state('');

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);
  modelOptions = $state<string[]>([]);
  providerOptions = $state<string[]>([]);
  tierOptions = $state<string[]>([]);

  summary = $state<UsageSummary | null>(null);
  daily = $state<UsageDailyPoint[]>([]);
  projects = $state<UsageProjectBreakdown[]>([]);
  models = $state<UsageModelBreakdown[]>([]);
  tiers = $state<UsageTierBreakdown[]>([]);
  agents = $state<UsageAgentBreakdown[]>([]);
  topSessions = $state<UsageTopSessionRow[]>([]);

  coverage = $state<UsageCoverage | null>(null);

  loading = $state<Record<PanelKey, boolean>>({
    summary: false,
    daily: false,
    projects: false,
    models: false,
    tiers: false,
    agents: false,
    topSessions: false,
  });

  errors = $state<Record<PanelKey, string | null>>({
    summary: null,
    daily: null,
    projects: null,
    models: null,
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
    return this.defaults.from;
  }

  get defaultTo(): string {
    return this.defaults.to;
  }

  get hasActiveFilters(): boolean {
    return (
      this.from !== this.defaults.from
      || this.to !== this.defaults.to
      || this.project !== ''
      || this.agent !== ''
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
    if (!this.hashListenerAttached && typeof window !== 'undefined') {
      window.addEventListener('hashchange', this.handleHashChange);
      this.hashListenerAttached = true;
    }

    if (typeof window !== 'undefined') {
      this.applyFilters(parseUsageHash(window.location.hash, this.filters));
    }

    if (!this.initialized) {
      await this.fetchFilterOptions();
      this.initialized = true;
    }

    await this.fetchAll();
  }

  dispose(): void {
    if (this.hashListenerAttached && typeof window !== 'undefined') {
      window.removeEventListener('hashchange', this.handleHashChange);
      this.hashListenerAttached = false;
    }
    this.abortAll();
  }

  async fetchAll(): Promise<void> {
    await Promise.all([
      this.fetchSummary(),
      this.fetchDaily(),
      this.fetchProjects(),
      this.fetchModels(),
      this.fetchTiers(),
      this.fetchAgents(),
      this.fetchTopSessions(),
    ]);
  }

  async fetchSummary(): Promise<void> {
    const version = ++this.versions.summary;
    const signal = this.nextSignal('summary');
    this.loading.summary = true;
    this.errors.summary = null;
    try {
      const result = await fetchUsageSummary(this.queryParams, { signal });
      if (version !== this.versions.summary) return;
      this.summary = result;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.summary) return;
      console.error('Failed to load usage summary:', err);
      this.errors.summary = 'Failed to load usage summary.';
    } finally {
      if (version === this.versions.summary) {
        this.loading.summary = false;
      }
    }
  }

  async fetchDaily(): Promise<void> {
    const version = ++this.versions.daily;
    const signal = this.nextSignal('daily');
    this.loading.daily = true;
    this.errors.daily = null;
    try {
      const result = await fetchUsageDaily(this.queryParams, { signal });
      if (version !== this.versions.daily) return;
      this.daily = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.daily) return;
      console.error('Failed to load usage timeline:', err);
      this.errors.daily = 'Failed to load usage timeline.';
    } finally {
      if (version === this.versions.daily) {
        this.loading.daily = false;
      }
    }
  }

  async fetchProjects(): Promise<void> {
    const version = ++this.versions.projects;
    const signal = this.nextSignal('projects');
    this.loading.projects = true;
    this.errors.projects = null;
    try {
      const result = await fetchUsageProjects(this.queryParams, { signal });
      if (version !== this.versions.projects) return;
      this.projects = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.projects) return;
      console.error('Failed to load usage by project:', err);
      this.errors.projects = 'Failed to load project attribution.';
    } finally {
      if (version === this.versions.projects) {
        this.loading.projects = false;
      }
    }
  }

  async fetchModels(): Promise<void> {
    const version = ++this.versions.models;
    const signal = this.nextSignal('models');
    this.loading.models = true;
    this.errors.models = null;
    try {
      const result = await fetchUsageModels(this.queryParams, { signal });
      if (version !== this.versions.models) return;
      this.models = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.models) return;
      console.error('Failed to load usage by model:', err);
      this.errors.models = 'Failed to load model attribution.';
    } finally {
      if (version === this.versions.models) {
        this.loading.models = false;
      }
    }
  }

  async fetchTiers(): Promise<void> {
    const version = ++this.versions.tiers;
    const signal = this.nextSignal('tiers');
    this.loading.tiers = true;
    this.errors.tiers = null;
    try {
      const result = await fetchUsageTiers(this.queryParams, { signal });
      if (version !== this.versions.tiers) return;
      this.tiers = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.tiers) return;
      console.error('Failed to load usage by tier:', err);
      this.errors.tiers = 'Failed to load tier attribution.';
    } finally {
      if (version === this.versions.tiers) {
        this.loading.tiers = false;
      }
    }
  }

  async fetchAgents(): Promise<void> {
    const version = ++this.versions.agents;
    const signal = this.nextSignal('agents');
    this.loading.agents = true;
    this.errors.agents = null;
    try {
      const result = await fetchUsageAgents(this.queryParams, { signal });
      if (version !== this.versions.agents) return;
      this.agents = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.agents) return;
      console.error('Failed to load usage by agent:', err);
      this.errors.agents = 'Failed to load agent attribution.';
    } finally {
      if (version === this.versions.agents) {
        this.loading.agents = false;
      }
    }
  }

  async fetchTopSessions(): Promise<void> {
    const version = ++this.versions.topSessions;
    const signal = this.nextSignal('topSessions');
    this.loading.topSessions = true;
    this.errors.topSessions = null;
    try {
      const result = await fetchUsageTopSessions({ ...this.queryParams, limit: 10 }, { signal });
      if (version !== this.versions.topSessions) return;
      this.topSessions = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (isAbortError(err)) return;
      if (version !== this.versions.topSessions) return;
      console.error('Failed to load top usage sessions:', err);
      this.errors.topSessions = 'Failed to load top sessions.';
    } finally {
      if (version === this.versions.topSessions) {
        this.loading.topSessions = false;
      }
    }
  }

  async setDateRange(from: string, to: string): Promise<void> {
    this.from = from;
    this.to = to < from ? from : to;
    this.syncHash();
    await this.refreshUsage();
  }

  async applyQuickRange(days: number): Promise<void> {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - (days - 1));
    await this.setDateRange(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
  }

  async setProject(project: string): Promise<void> {
    this.project = project;
    this.syncHash();
    await this.refreshUsage();
  }

  async setAgent(agent: string): Promise<void> {
    this.agent = agent;
    this.syncHash();
    await this.refreshUsage();
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.syncHash();
    await this.refreshUsage();
  }

  async setProvider(provider: string): Promise<void> {
    this.provider = provider;
    this.syncHash();
    await this.refreshUsage();
  }

  async setTier(tier: string): Promise<void> {
    this.tier = tier;
    this.syncHash();
    await this.refreshUsage();
  }

  async clearAllFilters(): Promise<void> {
    this.applyFilters(this.defaults);
    this.syncHash();
    await this.refreshUsage();
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

  private applyFilters(filters: FiltersSnapshot): void {
    this.from = filters.from;
    this.to = filters.to;
    this.project = filters.project;
    this.agent = filters.agent;
    this.model = filters.model;
    this.provider = filters.provider;
    this.tier = filters.tier;
  }

  private syncHash(): void {
    if (typeof window === 'undefined') return;
    const nextHash = buildUsageHash(this.filters);
    const nextUrl = `${window.location.pathname}${window.location.search}#${nextHash}`;
    window.history.replaceState(null, '', nextUrl);
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
      const [projectsRes, agentsRes, modelsRes, providerTiersRes, tierTiersRes] = await Promise.all([
        fetchUsageProjects(this.facetQueryParams('project'), { signal: controller.signal }),
        fetchUsageAgents(this.facetQueryParams('agent'), { signal: controller.signal }),
        fetchUsageModels(this.facetQueryParams('model'), { signal: controller.signal }),
        fetchUsageTiers(this.facetQueryParams('provider'), { signal: controller.signal }),
        fetchUsageTiers(this.facetQueryParams('tier'), { signal: controller.signal }),
      ]);

      if (version !== this.filterOptionsVersion) return;

      this.projectOptions = withSelectedOption(projectsRes.data.map(row => row.project), this.project);
      this.agentOptions = withSelectedOption(agentsRes.data.map(row => row.agent), this.agent);
      this.modelOptions = withSelectedOption(modelsRes.data.map(row => row.model), this.model);
      this.providerOptions = withSelectedOption(providerTiersRes.data.map(row => row.provider), this.provider);
      this.tierOptions = withSelectedOption(tierTiersRes.data.map(row => row.tier), this.tier);
    } catch (err) {
      if (isAbortError(err)) return;
      // Usage can still load without refreshed filter options.
    } finally {
      if (this.filterOptionsController === controller) {
        this.filterOptionsController = null;
      }
    }
  }

  private facetQueryParams(exclude: UsageFacetKey): Record<string, string> {
    const params: Record<string, string> = {
      date_from: this.from,
      date_to: this.to,
    };

    for (const key of ['project', 'agent', 'model', 'provider', 'tier'] as const) {
      if (key !== exclude && this[key]) {
        params[key] = this[key];
      }
    }

    return params;
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

  private readonly handleHashChange = (): void => {
    if (typeof window === 'undefined') return;
    const next = parseUsageHash(window.location.hash, this.filters);
    const changed = (
      next.from !== this.from
      || next.to !== this.to
      || next.project !== this.project
      || next.agent !== this.agent
      || next.model !== this.model
      || next.provider !== this.provider
      || next.tier !== this.tier
    );
    if (!changed) return;
    this.applyFilters(next);
    if (this.initialized) {
      void this.refreshUsage();
    }
  };
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
