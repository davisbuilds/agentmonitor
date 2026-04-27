import {
  fetchUsageSummary,
  fetchUsageDaily,
  fetchUsageProjects,
  fetchUsageModels,
  fetchUsageAgents,
  fetchUsageTopSessions,
  type UsageSummary,
  type UsageCoverage,
  type UsageDailyPoint,
  type UsageProjectBreakdown,
  type UsageModelBreakdown,
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
  | 'agents'
  | 'topSessions';

type FiltersSnapshot = {
  from: string;
  to: string;
  project: string;
  agent: string;
};

class UsageStore {
  private readonly defaults = createDefaultUsageFilters();
  private readonly versions: Record<PanelKey, number> = {
    summary: 0,
    daily: 0,
    projects: 0,
    models: 0,
    agents: 0,
    topSessions: 0,
  };
  private initialized = false;
  private hashListenerAttached = false;

  from = $state(this.defaults.from);
  to = $state(this.defaults.to);
  project = $state('');
  agent = $state('');

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);

  summary = $state<UsageSummary | null>(null);
  daily = $state<UsageDailyPoint[]>([]);
  projects = $state<UsageProjectBreakdown[]>([]);
  models = $state<UsageModelBreakdown[]>([]);
  agents = $state<UsageAgentBreakdown[]>([]);
  topSessions = $state<UsageTopSessionRow[]>([]);

  coverage = $state<UsageCoverage | null>(null);

  loading = $state<Record<PanelKey, boolean>>({
    summary: false,
    daily: false,
    projects: false,
    models: false,
    agents: false,
    topSessions: false,
  });

  errors = $state<Record<PanelKey, string | null>>({
    summary: null,
    daily: null,
    projects: null,
    models: null,
    agents: null,
    topSessions: null,
  });

  get filters(): FiltersSnapshot {
    return {
      from: this.from,
      to: this.to,
      project: this.project,
      agent: this.agent,
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
      try {
        const [projectsRes, agentsRes] = await Promise.all([
          fetchUsageProjects({ date_from: this.from, date_to: this.to }),
          fetchUsageAgents({ date_from: this.from, date_to: this.to }),
        ]);
        this.projectOptions = projectsRes.data.map(row => row.project).sort((a, b) => a.localeCompare(b));
        this.agentOptions = agentsRes.data.map(row => row.agent).sort((a, b) => a.localeCompare(b));
      } catch {
        // Usage can still load without filter options.
      }
      this.initialized = true;
    }

    await this.fetchAll();
  }

  dispose(): void {
    if (this.hashListenerAttached && typeof window !== 'undefined') {
      window.removeEventListener('hashchange', this.handleHashChange);
      this.hashListenerAttached = false;
    }
  }

  async fetchAll(): Promise<void> {
    await Promise.all([
      this.fetchSummary(),
      this.fetchDaily(),
      this.fetchProjects(),
      this.fetchModels(),
      this.fetchAgents(),
      this.fetchTopSessions(),
    ]);
  }

  async fetchSummary(): Promise<void> {
    const version = ++this.versions.summary;
    this.loading.summary = true;
    this.errors.summary = null;
    try {
      const result = await fetchUsageSummary(this.queryParams);
      if (version !== this.versions.summary) return;
      this.summary = result;
      this.coverage = result.coverage;
    } catch (err) {
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
    this.loading.daily = true;
    this.errors.daily = null;
    try {
      const result = await fetchUsageDaily(this.queryParams);
      if (version !== this.versions.daily) return;
      this.daily = result.data;
      this.coverage = result.coverage;
    } catch (err) {
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
    this.loading.projects = true;
    this.errors.projects = null;
    try {
      const result = await fetchUsageProjects(this.queryParams);
      if (version !== this.versions.projects) return;
      this.projects = result.data;
      this.coverage = result.coverage;
    } catch (err) {
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
    this.loading.models = true;
    this.errors.models = null;
    try {
      const result = await fetchUsageModels(this.queryParams);
      if (version !== this.versions.models) return;
      this.models = result.data;
      this.coverage = result.coverage;
    } catch (err) {
      if (version !== this.versions.models) return;
      console.error('Failed to load usage by model:', err);
      this.errors.models = 'Failed to load model attribution.';
    } finally {
      if (version === this.versions.models) {
        this.loading.models = false;
      }
    }
  }

  async fetchAgents(): Promise<void> {
    const version = ++this.versions.agents;
    this.loading.agents = true;
    this.errors.agents = null;
    try {
      const result = await fetchUsageAgents(this.queryParams);
      if (version !== this.versions.agents) return;
      this.agents = result.data;
      this.coverage = result.coverage;
    } catch (err) {
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
    this.loading.topSessions = true;
    this.errors.topSessions = null;
    try {
      const result = await fetchUsageTopSessions({ ...this.queryParams, limit: 10 });
      if (version !== this.versions.topSessions) return;
      this.topSessions = result.data;
      this.coverage = result.coverage;
    } catch (err) {
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
    await this.fetchAll();
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
    await this.fetchAll();
  }

  async setAgent(agent: string): Promise<void> {
    this.agent = agent;
    this.syncHash();
    await this.fetchAll();
  }

  async clearAllFilters(): Promise<void> {
    this.applyFilters(this.defaults);
    this.syncHash();
    await this.fetchAll();
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
  }

  private syncHash(): void {
    if (typeof window === 'undefined') return;
    const nextHash = buildUsageHash(this.filters);
    const nextUrl = `${window.location.pathname}${window.location.search}#${nextHash}`;
    window.history.replaceState(null, '', nextUrl);
  }

  private readonly handleHashChange = (): void => {
    if (typeof window === 'undefined') return;
    const next = parseUsageHash(window.location.hash, this.filters);
    const changed = (
      next.from !== this.from
      || next.to !== this.to
      || next.project !== this.project
      || next.agent !== this.agent
    );
    if (!changed) return;
    this.applyFilters(next);
    if (this.initialized) {
      void this.fetchAll();
    }
  };
}

export const usage = new UsageStore();
