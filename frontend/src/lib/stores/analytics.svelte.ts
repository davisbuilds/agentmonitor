import {
  fetchAnalyticsSummary,
  fetchAnalyticsActivity,
  fetchAnalyticsProjects,
  fetchAnalyticsTools,
  fetchAnalyticsHourOfWeek,
  fetchAnalyticsTopSessions,
  fetchAnalyticsVelocity,
  fetchAnalyticsAgents,
  fetchV2Projects,
  fetchV2Agents,
  type AnalyticsSummary,
  type AnalyticsCoverage,
  type ActivityDataPoint,
  type ProjectBreakdown,
  type ToolUsageStat,
  type HourOfWeekDataPoint,
  type TopSessionStat,
  type VelocityMetrics,
  type AgentComparisonRow,
} from '../api/client';
import { navigateToSession } from './router.svelte';
import {
  createDefaultAnalyticsFilters,
  buildAnalyticsHash,
  parseAnalyticsHash,
  buildAnalyticsCsv,
  downloadAnalyticsCsv,
} from '../analytics-state';

type PanelKey =
  | 'summary'
  | 'activity'
  | 'projects'
  | 'tools'
  | 'hourOfWeek'
  | 'topSessions'
  | 'velocity'
  | 'agents';

type FiltersSnapshot = {
  from: string;
  to: string;
  project: string;
  agent: string;
};

function dateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysAgo(days: number, now = new Date()): string {
  const next = new Date(now);
  next.setDate(next.getDate() - days);
  return dateString(next);
}

class AnalyticsStore {
  private readonly defaults = createDefaultAnalyticsFilters();
  private readonly versions: Record<PanelKey, number> = {
    summary: 0,
    activity: 0,
    projects: 0,
    tools: 0,
    hourOfWeek: 0,
    topSessions: 0,
    velocity: 0,
    agents: 0,
  };
  private hashListenerAttached = false;
  private initialized = false;

  from = $state(this.defaults.from);
  to = $state(this.defaults.to);
  project = $state('');
  agent = $state('');

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);

  summary = $state<AnalyticsSummary | null>(null);
  activity = $state<ActivityDataPoint[]>([]);
  projectBreakdowns = $state<ProjectBreakdown[]>([]);
  toolUsage = $state<ToolUsageStat[]>([]);
  hourOfWeek = $state<HourOfWeekDataPoint[]>([]);
  topSessions = $state<TopSessionStat[]>([]);
  velocity = $state<VelocityMetrics | null>(null);
  agentComparison = $state<AgentComparisonRow[]>([]);

  coverage = $state<Record<PanelKey, AnalyticsCoverage | null>>({
    summary: null,
    activity: null,
    projects: null,
    tools: null,
    hourOfWeek: null,
    topSessions: null,
    velocity: null,
    agents: null,
  });

  loading = $state<Record<PanelKey, boolean>>({
    summary: false,
    activity: false,
    projects: false,
    tools: false,
    hourOfWeek: false,
    topSessions: false,
    velocity: false,
    agents: false,
  });

  errors = $state<Record<PanelKey, string | null>>({
    summary: null,
    activity: null,
    projects: null,
    tools: null,
    hourOfWeek: null,
    topSessions: null,
    velocity: null,
    agents: null,
  });

  get filters(): FiltersSnapshot {
    return {
      from: this.from,
      to: this.to,
      project: this.project,
      agent: this.agent,
    };
  }

  get hasActiveFilters(): boolean {
    return (
      this.from !== this.defaults.from
      || this.to !== this.defaults.to
      || this.project !== ''
      || this.agent !== ''
    );
  }

  get defaultFrom(): string {
    return this.defaults.from;
  }

  get defaultTo(): string {
    return this.defaults.to;
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
      this.applyFilters(parseAnalyticsHash(window.location.hash, this.filters));
    }

    if (!this.initialized) {
      const [projects, agents] = await Promise.all([
        fetchV2Projects().catch(() => ({ data: [] })),
        fetchV2Agents().catch(() => ({ data: [] })),
      ]);
      this.projectOptions = projects.data;
      this.agentOptions = agents.data;
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
      this.fetchActivity(),
      this.fetchProjects(),
      this.fetchTools(),
      this.fetchHourOfWeek(),
      this.fetchTopSessions(),
      this.fetchVelocity(),
      this.fetchAgents(),
    ]);
  }

  async fetchSummary(): Promise<void> {
    const version = ++this.versions.summary;
    this.loading.summary = true;
    this.errors.summary = null;
    try {
      const result = await fetchAnalyticsSummary(this.queryParams);
      if (version !== this.versions.summary) return;
      this.summary = result;
      this.coverage.summary = result.coverage;
    } catch (err) {
      if (version !== this.versions.summary) return;
      console.error('Failed to load analytics summary:', err);
      this.errors.summary = 'Failed to load analytics summary.';
    } finally {
      if (version === this.versions.summary) {
        this.loading.summary = false;
      }
    }
  }

  async fetchActivity(): Promise<void> {
    const version = ++this.versions.activity;
    this.loading.activity = true;
    this.errors.activity = null;
    try {
      const result = await fetchAnalyticsActivity(this.queryParams);
      if (version !== this.versions.activity) return;
      this.activity = result.data;
      this.coverage.activity = result.coverage;
    } catch (err) {
      if (version !== this.versions.activity) return;
      console.error('Failed to load analytics activity:', err);
      this.errors.activity = 'Failed to load activity.';
    } finally {
      if (version === this.versions.activity) {
        this.loading.activity = false;
      }
    }
  }

  async fetchProjects(): Promise<void> {
    const version = ++this.versions.projects;
    this.loading.projects = true;
    this.errors.projects = null;
    try {
      const result = await fetchAnalyticsProjects(this.queryParams);
      if (version !== this.versions.projects) return;
      this.projectBreakdowns = result.data;
      this.coverage.projects = result.coverage;
    } catch (err) {
      if (version !== this.versions.projects) return;
      console.error('Failed to load analytics projects:', err);
      this.errors.projects = 'Failed to load project breakdown.';
    } finally {
      if (version === this.versions.projects) {
        this.loading.projects = false;
      }
    }
  }

  async fetchTools(): Promise<void> {
    const version = ++this.versions.tools;
    this.loading.tools = true;
    this.errors.tools = null;
    try {
      const result = await fetchAnalyticsTools(this.queryParams);
      if (version !== this.versions.tools) return;
      this.toolUsage = result.data;
      this.coverage.tools = result.coverage;
    } catch (err) {
      if (version !== this.versions.tools) return;
      console.error('Failed to load analytics tools:', err);
      this.errors.tools = 'Failed to load tool usage.';
    } finally {
      if (version === this.versions.tools) {
        this.loading.tools = false;
      }
    }
  }

  async fetchHourOfWeek(): Promise<void> {
    const version = ++this.versions.hourOfWeek;
    this.loading.hourOfWeek = true;
    this.errors.hourOfWeek = null;
    try {
      const result = await fetchAnalyticsHourOfWeek(this.queryParams);
      if (version !== this.versions.hourOfWeek) return;
      this.hourOfWeek = result.data;
      this.coverage.hourOfWeek = result.coverage;
    } catch (err) {
      if (version !== this.versions.hourOfWeek) return;
      console.error('Failed to load hour-of-week analytics:', err);
      this.errors.hourOfWeek = 'Failed to load hour-of-week view.';
    } finally {
      if (version === this.versions.hourOfWeek) {
        this.loading.hourOfWeek = false;
      }
    }
  }

  async fetchTopSessions(): Promise<void> {
    const version = ++this.versions.topSessions;
    this.loading.topSessions = true;
    this.errors.topSessions = null;
    try {
      const result = await fetchAnalyticsTopSessions({ ...this.queryParams, limit: 10 });
      if (version !== this.versions.topSessions) return;
      this.topSessions = result.data;
      this.coverage.topSessions = result.coverage;
    } catch (err) {
      if (version !== this.versions.topSessions) return;
      console.error('Failed to load top sessions:', err);
      this.errors.topSessions = 'Failed to load top sessions.';
    } finally {
      if (version === this.versions.topSessions) {
        this.loading.topSessions = false;
      }
    }
  }

  async fetchVelocity(): Promise<void> {
    const version = ++this.versions.velocity;
    this.loading.velocity = true;
    this.errors.velocity = null;
    try {
      const result = await fetchAnalyticsVelocity(this.queryParams);
      if (version !== this.versions.velocity) return;
      this.velocity = result;
      this.coverage.velocity = result.coverage;
    } catch (err) {
      if (version !== this.versions.velocity) return;
      console.error('Failed to load analytics velocity:', err);
      this.errors.velocity = 'Failed to load velocity metrics.';
    } finally {
      if (version === this.versions.velocity) {
        this.loading.velocity = false;
      }
    }
  }

  async fetchAgents(): Promise<void> {
    const version = ++this.versions.agents;
    this.loading.agents = true;
    this.errors.agents = null;
    try {
      const result = await fetchAnalyticsAgents(this.queryParams);
      if (version !== this.versions.agents) return;
      this.agentComparison = result.data;
      this.coverage.agents = result.coverage;
    } catch (err) {
      if (version !== this.versions.agents) return;
      console.error('Failed to load agent comparison:', err);
      this.errors.agents = 'Failed to load agent comparison.';
    } finally {
      if (version === this.versions.agents) {
        this.loading.agents = false;
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
    this.from = daysAgo(days - 1);
    this.to = dateString(new Date());
    this.syncHash();
    await this.fetchAll();
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

  async clearDateRange(): Promise<void> {
    this.from = this.defaults.from;
    this.to = this.defaults.to;
    this.syncHash();
    await this.fetchAll();
  }

  async clearProject(): Promise<void> {
    this.project = '';
    this.syncHash();
    await this.fetchAll();
  }

  async clearAgent(): Promise<void> {
    this.agent = '';
    this.syncHash();
    await this.fetchAll();
  }

  async clearAllFilters(): Promise<void> {
    this.applyFilters(this.defaults);
    this.syncHash();
    await this.fetchAll();
  }

  async drillDownToDay(date: string): Promise<void> {
    await this.setDateRange(date, date);
  }

  async drillDownToProject(project: string): Promise<void> {
    await this.setProject(project);
  }

  async drillDownToAgent(agent: string): Promise<void> {
    await this.setAgent(agent);
  }

  openSession(sessionId: string): void {
    navigateToSession(sessionId);
  }

  exportCsv(): void {
    const csv = buildAnalyticsCsv({
      generatedAt: new Date().toISOString(),
      filters: this.filters,
      summary: this.summary,
      velocity: this.velocity,
      activity: this.activity,
      projects: this.projectBreakdowns,
      tools: this.toolUsage,
      topSessions: this.topSessions,
      agents: this.agentComparison,
    });
    downloadAnalyticsCsv(`agentmonitor-analytics-${this.from}-to-${this.to}.csv`, csv);
  }

  private applyFilters(filters: FiltersSnapshot): void {
    this.from = filters.from;
    this.to = filters.to;
    this.project = filters.project;
    this.agent = filters.agent;
  }

  private syncHash(): void {
    if (typeof window === 'undefined') return;
    const nextHash = buildAnalyticsHash(this.filters);
    const nextUrl = `${window.location.pathname}${window.location.search}#${nextHash}`;
    window.history.replaceState(null, '', nextUrl);
  }

  private readonly handleHashChange = (): void => {
    if (typeof window === 'undefined') return;
    const next = parseAnalyticsHash(window.location.hash, this.filters);
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

export const analytics = new AnalyticsStore();
