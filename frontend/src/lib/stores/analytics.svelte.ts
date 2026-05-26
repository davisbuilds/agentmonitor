import {
  fetchAnalyticsSummary,
  fetchAnalyticsActivity,
  fetchAnalyticsProjects,
  fetchAnalyticsTools,
  fetchAnalyticsSkillsDaily,
  fetchAnalyticsHourOfWeek,
  fetchAnalyticsTopSessions,
  fetchAnalyticsVelocity,
  fetchAnalyticsAgents,
  type AnalyticsSummary,
  type AnalyticsCoverage,
  type ActivityDataPoint,
  type ProjectBreakdown,
  type ToolUsageStat,
  type SkillUsageDay,
  type HourOfWeekDataPoint,
  type TopSessionStat,
  type VelocityMetrics,
  type AgentComparisonRow,
} from '../api/client';
import { navigateToSession } from './router.svelte';
import { analyticsFilters } from './analytics-filters.svelte';
import {
  buildAnalyticsCsv,
  downloadAnalyticsCsv,
} from '../analytics-state';

type PanelKey =
  | 'summary'
  | 'activity'
  | 'projects'
  | 'tools'
  | 'skills'
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

class AnalyticsStore {
  private readonly versions: Record<PanelKey, number> = {
    summary: 0,
    activity: 0,
    projects: 0,
    tools: 0,
    skills: 0,
    hourOfWeek: 0,
    topSessions: 0,
    velocity: 0,
    agents: 0,
  };
  private unsubscribe: (() => void) | null = null;

  // Shared filters live in the consolidated analytics filter store; the Overview
  // sub-view reads from it and refetches when it changes.
  get from(): string { return analyticsFilters.from; }
  get to(): string { return analyticsFilters.to; }
  get project(): string { return analyticsFilters.project; }
  get agent(): string { return analyticsFilters.agent; }

  get projectOptions(): string[] { return analyticsFilters.projectOptions; }
  get agentOptions(): string[] { return analyticsFilters.agentOptions; }

  summary = $state<AnalyticsSummary | null>(null);
  activity = $state<ActivityDataPoint[]>([]);
  projectBreakdowns = $state<ProjectBreakdown[]>([]);
  toolUsage = $state<ToolUsageStat[]>([]);
  skillUsageDaily = $state<SkillUsageDay[]>([]);
  hourOfWeek = $state<HourOfWeekDataPoint[]>([]);
  topSessions = $state<TopSessionStat[]>([]);
  velocity = $state<VelocityMetrics | null>(null);
  agentComparison = $state<AgentComparisonRow[]>([]);

  coverage = $state<Record<PanelKey, AnalyticsCoverage | null>>({
    summary: null,
    activity: null,
    projects: null,
    tools: null,
    skills: null,
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
    skills: false,
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
    skills: null,
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
    return analyticsFilters.hasActiveSharedFilters;
  }

  get defaultFrom(): string {
    return analyticsFilters.defaultFrom;
  }

  get defaultTo(): string {
    return analyticsFilters.defaultTo;
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
    if (!this.unsubscribe) {
      this.unsubscribe = analyticsFilters.subscribe(() => {
        void this.fetchAll();
      });
    }
    await analyticsFilters.initialize();
    await this.fetchAll();
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async fetchAll(): Promise<void> {
    await Promise.all([
      this.fetchSummary(),
      this.fetchActivity(),
      this.fetchProjects(),
      this.fetchTools(),
      this.fetchSkills(),
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

  async fetchSkills(): Promise<void> {
    const version = ++this.versions.skills;
    this.loading.skills = true;
    this.errors.skills = null;
    try {
      const result = await fetchAnalyticsSkillsDaily(this.queryParams);
      if (version !== this.versions.skills) return;
      this.skillUsageDaily = result.data;
      this.coverage.skills = result.coverage;
    } catch (err) {
      if (version !== this.versions.skills) return;
      console.error('Failed to load skill analytics:', err);
      this.errors.skills = 'Failed to load skill analytics.';
    } finally {
      if (version === this.versions.skills) {
        this.loading.skills = false;
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

  // Filter mutations delegate to the shared store, which syncs the hash and
  // notifies subscribers (this store's fetchAll) — no direct fetch here.
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

  async clearDateRange(): Promise<void> {
    analyticsFilters.setDateRange(analyticsFilters.defaultFrom, analyticsFilters.defaultTo);
  }

  async clearProject(): Promise<void> {
    analyticsFilters.setProject('');
  }

  async clearAgent(): Promise<void> {
    analyticsFilters.setAgent('');
  }

  async clearAllFilters(): Promise<void> {
    analyticsFilters.clearSharedFilters();
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
      skills: this.skillUsageDaily,
      topSessions: this.topSessions,
      agents: this.agentComparison,
    });
    downloadAnalyticsCsv(`agentmonitor-analytics-${this.from}-to-${this.to}.csv`, csv);
  }
}

export const analytics = new AnalyticsStore();
