import {
  fetchInsights,
  generateInsight,
  deleteInsight,
  type Insight,
  type InsightGenerationStatus,
  type InsightKind,
  type InsightProvider,
} from '../api/client';
import {
  insightMatchesListFilters,
  sameInsightListFilters,
  type InsightListFilters,
} from '../insights-state';
import { analyticsFilters } from './analytics-filters.svelte';
import {
  anyInsightProviderConfigured,
  insightsViewAvailable,
  type InsightsAvailability,
} from '../analytics-views';

class InsightsStore {
  private listVersion = 0;
  private availabilityVersion = 0;
  private initialized = false;
  private unsubscribe: (() => void) | null = null;
  /** Whether any insight is saved at all, whatever the current filters select. */
  private hasSavedInsights = false;

  // Shared filters (date/project/agent) and the insight-specialized filters
  // (kind + authoring provider/model) live in the consolidated filter store.
  get defaultFrom(): string { return analyticsFilters.defaultFrom; }
  get defaultTo(): string { return analyticsFilters.defaultTo; }

  get from(): string { return analyticsFilters.from; }
  get to(): string { return analyticsFilters.to; }
  get project(): string { return analyticsFilters.project; }
  get agent(): string { return analyticsFilters.agent; }
  get kind(): InsightKind { return analyticsFilters.kind; }
  get provider(): InsightProvider { return analyticsFilters.insightProvider; }
  get model(): string { return analyticsFilters.insightModel; }
  prompt = $state('');

  get projectOptions(): string[] { return analyticsFilters.projectOptions; }
  get agentOptions(): string[] { return analyticsFilters.agentOptions; }

  items = $state<Insight[]>([]);
  selectedId = $state<number | null>(null);
  generation = $state<InsightGenerationStatus>({
    default_provider: 'openai',
    providers: {
      openai: { configured: false, default_model: 'gpt-5-mini' },
      anthropic: { configured: false, default_model: 'claude-sonnet-4-5' },
      gemini: { configured: false, default_model: 'gemini-2.5-flash' },
    },
  });

  /** Whether a provider has a key or an insight is saved; null until the status first loads. */
  availability = $state<InsightsAvailability>(null);

  loading = $state(false);
  generating = $state(false);
  deleting = $state(false);
  error = $state<string | null>(null);

  get selected(): Insight | null {
    return this.items.find(item => item.id === this.selectedId) ?? null;
  }

  get selectedProviderConfigured(): boolean {
    return this.generation.providers[this.provider]?.configured ?? false;
  }

  get queryParams(): Record<string, string> {
    const filters = this.listFilters;
    const params: Record<string, string> = {
      date_from: filters.from,
      date_to: filters.to,
      kind: filters.kind,
    };
    if (filters.project) params.project = filters.project;
    if (filters.agent) params.agent = filters.agent;
    return params;
  }

  get listFilters(): InsightListFilters {
    return {
      from: this.from,
      to: this.to,
      project: this.project,
      agent: this.agent,
      kind: this.kind,
    };
  }

  async initialize(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = analyticsFilters.subscribe(() => {
        void this.load();
      });
    }
    await analyticsFilters.initialize();
    this.initialized = true;
    await this.load();
  }

  /**
   * Learn whether any provider is configured or any insight is saved, without
   * loading the Insights page. The status rides the list response, so one
   * unfiltered row is requested.
   */
  async loadAvailability(): Promise<void> {
    const version = ++this.availabilityVersion;
    try {
      const result = await fetchInsights({ limit: 1 });
      if (version !== this.availabilityVersion) return;
      this.hasSavedInsights = result.data.length > 0;
      this.availability = insightsViewAvailable(result.generation, this.hasSavedInsights);
    } catch (err) {
      if (version !== this.availabilityVersion) return;
      // Without the status Insights can't be offered honestly; fall back
      // rather than leave a deep link waiting on it. A failed recheck is no
      // evidence that nothing is saved, so a known answer stands.
      console.error('Failed to load insight provider status:', err);
      if (this.availability === null) this.availability = false;
    }
  }

  /**
   * Without a key, Insights stays offered only while an insight is saved. An
   * empty slice can't tell whether any remain elsewhere, so ask unfiltered.
   */
  private needsAvailabilityCheck(): boolean {
    return this.items.length === 0 && !anyInsightProviderConfigured(this.generation);
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async load(): Promise<void> {
    const version = ++this.listVersion;
    this.loading = true;
    this.error = null;
    let recheck = false;

    try {
      const result = await fetchInsights(this.queryParams);
      if (version !== this.listVersion) return;
      this.items = result.data;
      this.generation = result.generation;
      // An empty filtered slice says nothing about the other saved insights, so
      // it must not hide the view on a keyless server; the unfiltered recheck
      // below decides whether any remain.
      if (result.data.length > 0) this.hasSavedInsights = true;
      recheck = this.needsAvailabilityCheck();
      // Rows or a key in hand outrank an unfiltered read still in flight;
      // otherwise the recheck below supersedes it.
      if (!recheck) this.availabilityVersion++;
      this.availability = insightsViewAvailable(result.generation, this.hasSavedInsights);
      if (!analyticsFilters.insightModel) {
        const defaultProvider = result.generation.default_provider;
        analyticsFilters.setInsightProvider(defaultProvider);
        analyticsFilters.setInsightModel(result.generation.providers[defaultProvider].default_model);
      }
      if (this.items.length === 0) {
        this.selectedId = null;
      } else if (!this.items.some(item => item.id === this.selectedId)) {
        this.selectedId = this.items[0]?.id ?? null;
      }
    } catch (err) {
      if (version !== this.listVersion) return;
      console.error('Failed to load insights:', err);
      this.error = 'Failed to load insights.';
      this.items = [];
      this.selectedId = null;
    } finally {
      if (version === this.listVersion) {
        this.loading = false;
      }
    }
    if (recheck) await this.loadAvailability();
  }

  // Shared/specialized filter mutations delegate to the shared store, which
  // notifies subscribers (this store's load) — no direct load here.
  async setDateRange(from: string, to: string): Promise<void> {
    analyticsFilters.setDateRange(from, to);
  }

  async setProject(project: string): Promise<void> {
    analyticsFilters.setProject(project);
  }

  async setAgent(agent: string): Promise<void> {
    analyticsFilters.setAgent(agent);
  }

  async setKind(kind: InsightKind): Promise<void> {
    analyticsFilters.setKind(kind);
  }

  setProvider(provider: InsightProvider): void {
    analyticsFilters.setInsightProvider(provider);
    analyticsFilters.setInsightModel(this.generation.providers[provider].default_model);
  }

  setModel(model: string): void {
    analyticsFilters.setInsightModel(model);
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  select(id: number): void {
    this.selectedId = id;
  }

  async applyQuickRange(days: number): Promise<void> {
    analyticsFilters.applyQuickRange(days);
  }

  async clearFilters(): Promise<void> {
    analyticsFilters.batch(() => {
      analyticsFilters.clearSharedFilters();
      analyticsFilters.setKind('overview');
      analyticsFilters.setInsightProvider(this.generation.default_provider);
      analyticsFilters.setInsightModel(this.generation.providers[this.generation.default_provider].default_model);
    });
  }

  async generate(): Promise<void> {
    // Saved insights are readable without a key; generating one still needs it.
    if (!this.selectedProviderConfigured) return;
    const requestFilters = this.listFilters;
    this.generating = true;
    this.error = null;

    try {
      const created = await generateInsight({
        kind: this.kind,
        date_from: this.from,
        date_to: this.to,
        project: this.project || undefined,
        agent: this.agent || undefined,
        prompt: this.prompt.trim() || undefined,
        provider: this.provider,
        model: this.model.trim() || undefined,
      });
      if (
        sameInsightListFilters(requestFilters, this.listFilters)
        && insightMatchesListFilters(created, this.listFilters)
      ) {
        this.items = [created, ...this.items.filter(item => item.id !== created.id)];
        this.selectedId = created.id;
      }
    } catch (err) {
      console.error('Failed to generate insight:', err);
      this.error = err instanceof Error ? err.message : 'Failed to generate insight.';
    } finally {
      this.generating = false;
    }
  }

  async removeSelected(): Promise<void> {
    if (!this.selectedId) return;

    this.deleting = true;
    this.error = null;
    const id = this.selectedId;
    let recheck = false;
    try {
      await deleteInsight(id);
      this.items = this.items.filter(item => item.id !== id);
      this.selectedId = this.items[0]?.id ?? null;
      recheck = this.needsAvailabilityCheck();
    } catch (err) {
      console.error('Failed to delete insight:', err);
      this.error = err instanceof Error ? err.message : 'Failed to delete insight.';
    } finally {
      this.deleting = false;
    }
    if (recheck) await this.loadAvailability();
  }
}

export const insights = new InsightsStore();
