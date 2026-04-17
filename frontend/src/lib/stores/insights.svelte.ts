import {
  fetchInsights,
  fetchV2Agents,
  fetchV2Projects,
  generateInsight,
  deleteInsight,
  type Insight,
  type InsightGenerationStatus,
  type InsightKind,
  type InsightProvider,
} from '../api/client';

function localDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateStr(date);
}

class InsightsStore {
  private listVersion = 0;
  private initialized = false;

  readonly defaultFrom = daysAgo(29);
  readonly defaultTo = localDateStr(new Date());

  from = $state(this.defaultFrom);
  to = $state(this.defaultTo);
  project = $state('');
  agent = $state('');
  kind = $state<InsightKind>('overview');
  provider = $state<InsightProvider>('openai');
  model = $state('');
  prompt = $state('');

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);

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
    const params: Record<string, string> = {
      date_from: this.from,
      date_to: this.to,
      kind: this.kind,
    };
    if (this.project) params.project = this.project;
    if (this.agent) params.agent = this.agent;
    return params;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const [projects, agents] = await Promise.all([
        fetchV2Projects().catch(() => ({ data: [] })),
        fetchV2Agents().catch(() => ({ data: [] })),
      ]);
      this.projectOptions = [...projects.data].sort((a, b) => a.localeCompare(b));
      this.agentOptions = [...agents.data].sort((a, b) => a.localeCompare(b));
      this.initialized = true;
    }

    await this.load();
  }

  async load(): Promise<void> {
    const version = ++this.listVersion;
    this.loading = true;
    this.error = null;

    try {
      const result = await fetchInsights(this.queryParams);
      if (version !== this.listVersion) return;
      this.items = result.data;
      this.generation = result.generation;
      if (!this.model) {
        this.provider = result.generation.default_provider;
        this.model = result.generation.providers[this.provider].default_model;
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
  }

  async setDateRange(from: string, to: string): Promise<void> {
    this.from = from;
    this.to = to;
    await this.load();
  }

  async setProject(project: string): Promise<void> {
    this.project = project;
    await this.load();
  }

  async setAgent(agent: string): Promise<void> {
    this.agent = agent;
    await this.load();
  }

  async setKind(kind: InsightKind): Promise<void> {
    this.kind = kind;
    await this.load();
  }

  setProvider(provider: InsightProvider): void {
    this.provider = provider;
    this.model = this.generation.providers[provider].default_model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  select(id: number): void {
    this.selectedId = id;
  }

  async applyQuickRange(days: number): Promise<void> {
    this.from = daysAgo(days - 1);
    this.to = this.defaultTo;
    await this.load();
  }

  async clearFilters(): Promise<void> {
    this.from = this.defaultFrom;
    this.to = this.defaultTo;
    this.project = '';
    this.agent = '';
    this.kind = 'overview';
    this.provider = this.generation.default_provider;
    this.model = this.generation.providers[this.provider].default_model;
    await this.load();
  }

  async generate(): Promise<void> {
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
      this.items = [created, ...this.items.filter(item => item.id !== created.id)];
      this.selectedId = created.id;
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
    try {
      await deleteInsight(id);
      this.items = this.items.filter(item => item.id !== id);
      this.selectedId = this.items[0]?.id ?? null;
    } catch (err) {
      console.error('Failed to delete insight:', err);
      this.error = err instanceof Error ? err.message : 'Failed to delete insight.';
    } finally {
      this.deleting = false;
    }
  }
}

export const insights = new InsightsStore();
