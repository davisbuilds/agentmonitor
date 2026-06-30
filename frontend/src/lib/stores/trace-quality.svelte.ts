import {
  fetchTraceQualityTraces,
  fetchTraceQualityTrace,
  fetchTraceQualityObservations,
  type TraceQualityTrace,
  type TraceQualityTraceDetail,
  type TraceQualityObservationTreeNode,
  type TraceQualityReadCoverage,
} from '../api/client';
import { analyticsFilters } from './analytics-filters.svelte';

/** Flatten an observation tree depth-first to locate a node by id. */
function findNode(
  nodes: readonly TraceQualityObservationTreeNode[],
  id: string,
): TraceQualityObservationTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

class TraceQualityStore {
  private listVersion = 0;
  private detailVersion = 0;
  private unsubscribe: (() => void) | null = null;

  get from(): string { return analyticsFilters.from; }
  get to(): string { return analyticsFilters.to; }
  get project(): string { return analyticsFilters.project; }
  get agent(): string { return analyticsFilters.agent; }
  get projectOptions(): string[] { return analyticsFilters.projectOptions; }
  get agentOptions(): string[] { return analyticsFilters.agentOptions; }

  // List
  traces = $state<TraceQualityTrace[]>([]);
  coverage = $state<TraceQualityReadCoverage | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  // Selected trace detail
  detail = $state<TraceQualityTraceDetail | null>(null);
  tree = $state<TraceQualityObservationTreeNode[]>([]);
  detailLoading = $state(false);
  detailError = $state<string | null>(null);

  // Selected observation within the open trace (read from the loaded tree —
  // the lean view has no per-observation detail endpoint to refetch).
  selectedObservationId = $state<string | null>(null);

  get selectedObservation(): TraceQualityObservationTreeNode | null {
    if (!this.selectedObservationId) return null;
    return findNode(this.tree, this.selectedObservationId);
  }

  get selectedTraceId(): string | null {
    return analyticsFilters.traceId;
  }

  /** When set (via drill-in), the list is scoped to one session and ignores the date window. */
  get sessionScope(): string | null {
    return analyticsFilters.sessionId;
  }

  clearSessionScope(): void {
    analyticsFilters.clearSessionScope();
  }

  private get listParams(): Record<string, string> {
    // A session scope (drill-in) targets one session's traces regardless of when they ran,
    // so it overrides the shared date window. Otherwise filter by the date/project/agent bar.
    if (this.sessionScope) {
      const scoped: Record<string, string> = { session_id: this.sessionScope };
      if (this.project) scoped.project = this.project;
      if (this.agent) scoped.agent = this.agent;
      return scoped;
    }
    const params: Record<string, string> = { date_from: this.from, date_to: this.to };
    if (this.project) params.project = this.project;
    if (this.agent) params.agent = this.agent;
    return params;
  }

  async initialize(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = analyticsFilters.subscribe(() => {
        void this.load();
      });
    }
    await analyticsFilters.initialize();
    await this.load();
    if (this.selectedTraceId) await this.loadDetail(this.selectedTraceId);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async load(): Promise<void> {
    const version = ++this.listVersion;
    this.loading = true;
    this.error = null;
    try {
      const result = await fetchTraceQualityTraces(this.listParams);
      if (version !== this.listVersion) return;
      this.traces = result.data;
      this.coverage = result.coverage;
      // Reconcile the open trace against the new list / hash.
      const wanted = this.selectedTraceId;
      if (wanted && this.detail?.id !== wanted) {
        await this.loadDetail(wanted);
      } else if (!wanted && this.sessionScope && result.data.length === 1) {
        // Drill-in to a session with a single trace opens it directly.
        await this.selectTrace(result.data[0]!.id);
      } else if (!wanted) {
        this.clearDetail();
      }
    } catch (err) {
      if (version !== this.listVersion) return;
      console.error('Failed to load trace-quality traces:', err);
      this.error = 'Failed to load traces.';
      this.traces = [];
      this.coverage = null;
    } finally {
      if (version === this.listVersion) this.loading = false;
    }
  }

  async selectTrace(traceId: string): Promise<void> {
    analyticsFilters.setTraceId(traceId);
    await this.loadDetail(traceId);
  }

  clearSelection(): void {
    analyticsFilters.setTraceId(null);
    this.clearDetail();
  }

  private clearDetail(): void {
    this.detail = null;
    this.tree = [];
    this.selectedObservationId = null;
    this.detailError = null;
  }

  async loadDetail(traceId: string): Promise<void> {
    const version = ++this.detailVersion;
    this.detailLoading = true;
    this.detailError = null;
    this.selectedObservationId = null;
    try {
      const [trace, observations] = await Promise.all([
        fetchTraceQualityTrace(traceId),
        fetchTraceQualityObservations(traceId),
      ]);
      if (version !== this.detailVersion) return;
      this.detail = trace.trace;
      this.tree = observations.tree;
    } catch (err) {
      if (version !== this.detailVersion) return;
      console.error('Failed to load trace detail:', err);
      this.detailError = 'Failed to load trace detail.';
      this.detail = null;
      this.tree = [];
    } finally {
      if (version === this.detailVersion) this.detailLoading = false;
    }
  }

  selectObservation(observationId: string | null): void {
    this.selectedObservationId = observationId;
  }
}

export const traceQuality = new TraceQualityStore();
