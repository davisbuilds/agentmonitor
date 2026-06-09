import {
  fetchV2Agents,
  fetchV2Projects,
  type InsightKind,
  type InsightProvider,
} from '../api/client';
import {
  buildAnalyticsRouteHash,
  parseAnalyticsRouteHash,
  type AnalyticsRouteState,
  type AnalyticsView,
} from '../route-state';

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysAgo(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return localDateString(date);
}

export function createDefaultAnalyticsRouteState(now = new Date()): AnalyticsRouteState {
  return {
    view: 'overview',
    from: daysAgo(29, now),
    to: localDateString(now),
    project: '',
    agent: '',
    model: '',
    provider: '',
    tier: '',
    insightProvider: 'openai',
    insightModel: '',
    kind: 'overview',
    sessionId: null,
    traceId: null,
  };
}

/**
 * Single source of truth for the consolidated Analytics tab: the active sub-view
 * plus the shared (date/project/agent) and per-view specialized filters, the one
 * URL hash, and the shared project/agent option lists. Data stores
 * (`analytics`/`usage`/`insights`) read filters from here and `subscribe` for
 * refetch; only the mounted sub-view's store is subscribed, so a filter change
 * refetches just the visible surface.
 */
class AnalyticsFiltersStore {
  private readonly defaults = createDefaultAnalyticsRouteState();
  private hashListenerAttached = false;
  private optionsLoaded = false;
  private readonly subscribers = new Set<() => void>();
  private batchDepth = 0;
  private pendingNotify = false;

  view = $state<AnalyticsView>(this.defaults.view);
  from = $state(this.defaults.from);
  to = $state(this.defaults.to);
  project = $state('');
  agent = $state('');

  // Usage sub-view specialized filters.
  model = $state('');
  provider = $state('');
  tier = $state('');

  // Insights sub-view specialized filters (provider/model = the LLM that authors
  // the insight; distinct from Usage's billed provider/model).
  insightProvider = $state<InsightProvider>('openai');
  insightModel = $state('');
  kind = $state<InsightKind>('overview');

  // Quality sub-view: optional session scope (drill-in) and the open trace.
  sessionId = $state<string | null>(null);
  traceId = $state<string | null>(null);

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);

  get defaultFrom(): string {
    return this.defaults.from;
  }

  get defaultTo(): string {
    return this.defaults.to;
  }

  get snapshot(): AnalyticsRouteState {
    return {
      view: this.view,
      from: this.from,
      to: this.to,
      project: this.project,
      agent: this.agent,
      model: this.model,
      provider: this.provider,
      tier: this.tier,
      insightProvider: this.insightProvider,
      insightModel: this.insightModel,
      kind: this.kind,
      sessionId: this.sessionId,
      traceId: this.traceId,
    };
  }

  /** True when the shared (date/project/agent) filters differ from defaults. */
  get hasActiveSharedFilters(): boolean {
    return (
      this.from !== this.defaults.from
      || this.to !== this.defaults.to
      || this.project !== ''
      || this.agent !== ''
    );
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify(): void {
    if (this.batchDepth > 0) {
      this.pendingNotify = true;
      return;
    }
    for (const fn of this.subscribers) fn();
  }

  /**
   * Apply several filter mutations as one unit: subscriber refetches are
   * suppressed during `mutate` and fire at most once afterward. Without this,
   * a multi-field reset would emit one refetch per setter.
   */
  batch(mutate: () => void): void {
    this.batchDepth += 1;
    try {
      mutate();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.pendingNotify) {
        this.pendingNotify = false;
        for (const fn of this.subscribers) fn();
      }
    }
  }

  /** Attach the hash listener + seed filters from the URL, and load options once. */
  async initialize(): Promise<void> {
    if (!this.hashListenerAttached && typeof window !== 'undefined') {
      window.addEventListener('hashchange', this.handleHashChange);
      this.hashListenerAttached = true;
      this.applyState(parseAnalyticsRouteHash(window.location.hash, this.snapshot));
    }

    if (!this.optionsLoaded) {
      const [projects, agents] = await Promise.all([
        fetchV2Projects().catch(() => ({ data: [] })),
        fetchV2Agents().catch(() => ({ data: [] })),
      ]);
      this.projectOptions = [...projects.data].sort((a, b) => a.localeCompare(b));
      this.agentOptions = [...agents.data].sort((a, b) => a.localeCompare(b));
      this.optionsLoaded = true;
    }
  }

  private applyState(state: AnalyticsRouteState): void {
    this.view = state.view;
    this.from = state.from;
    this.to = state.to;
    this.project = state.project;
    this.agent = state.agent;
    this.model = state.model;
    this.provider = state.provider;
    this.tier = state.tier;
    this.insightProvider = (state.insightProvider as InsightProvider) || 'openai';
    this.insightModel = state.insightModel;
    this.kind = (state.kind as InsightKind) || 'overview';
    this.sessionId = state.sessionId;
    this.traceId = state.traceId;
  }

  private syncHash(): void {
    if (typeof window === 'undefined') return;
    const nextHash = buildAnalyticsRouteHash(this.snapshot);
    const nextUrl = `${window.location.pathname}${window.location.search}#${nextHash}`;
    window.history.replaceState(null, '', nextUrl);
  }

  /** Switch sub-view. The newly mounted sub-view refetches on its own mount. */
  setView(view: AnalyticsView): void {
    if (view === this.view) return;
    this.view = view;
    this.syncHash();
  }

  /**
   * Set the Quality explorer's open trace. Selection (not a filter), so it only
   * reflects to the hash for deep-linking — it does not notify list subscribers.
   */
  setTraceId(traceId: string | null): void {
    if (traceId === this.traceId) return;
    this.traceId = traceId;
    this.syncHash();
  }

  /** Clear the Quality explorer's session scope; reloads the (now unscoped) list. */
  clearSessionScope(): void {
    if (this.sessionId === null) return;
    this.sessionId = null;
    this.traceId = null;
    this.syncHash();
    this.notify();
  }

  // --- Shared filters (refetch the active sub-view) ---

  setDateRange(from: string, to: string): void {
    this.from = from;
    this.to = to < from ? from : to;
    this.syncHash();
    this.notify();
  }

  applyQuickRange(days: number): void {
    this.from = daysAgo(days - 1);
    this.to = localDateString(new Date());
    this.syncHash();
    this.notify();
  }

  setProject(project: string): void {
    this.project = project;
    this.syncHash();
    this.notify();
  }

  setAgent(agent: string): void {
    this.agent = agent;
    this.syncHash();
    this.notify();
  }

  // --- Usage specialized filters ---

  setModel(model: string): void {
    this.model = model;
    this.syncHash();
    this.notify();
  }

  setProvider(provider: string): void {
    this.provider = provider;
    this.syncHash();
    this.notify();
  }

  setTier(tier: string): void {
    this.tier = tier;
    this.syncHash();
    this.notify();
  }

  // --- Insights specialized filters ---

  setKind(kind: InsightKind): void {
    this.kind = kind;
    this.syncHash();
    this.notify();
  }

  // Insight provider/model select the authoring LLM; they don't affect the list
  // query, so they sync the hash but do not trigger a refetch.
  setInsightProvider(provider: InsightProvider): void {
    this.insightProvider = provider;
    this.syncHash();
  }

  setInsightModel(model: string): void {
    this.insightModel = model;
    this.syncHash();
  }

  clearSharedFilters(): void {
    this.from = this.defaults.from;
    this.to = this.defaults.to;
    this.project = '';
    this.agent = '';
    this.syncHash();
    this.notify();
  }

  private readonly handleHashChange = (): void => {
    if (typeof window === 'undefined') return;
    const next = parseAnalyticsRouteHash(window.location.hash, this.snapshot);
    const sharedChanged = (
      next.from !== this.from
      || next.to !== this.to
      || next.project !== this.project
      || next.agent !== this.agent
      || next.model !== this.model
      || next.provider !== this.provider
      || next.tier !== this.tier
      || next.kind !== this.kind
      || next.sessionId !== this.sessionId
    );
    this.applyState(next);
    if (sharedChanged) this.notify();
  };
}

export const analyticsFilters = new AnalyticsFiltersStore();
