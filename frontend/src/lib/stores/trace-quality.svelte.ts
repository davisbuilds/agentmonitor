import {
  fetchTraceQualityTraces,
  fetchTraceQualityTrace,
  fetchTraceQualityObservations,
  fetchTraceQualityObservation,
  fetchTraceQualityScores,
  createTraceQualityScore,
  deleteTraceQualityScore,
  type TraceQualityTrace,
  type TraceQualityTraceDetail,
  type TraceQualityObservationTreeNode,
  type TraceQualityObservationDetail,
  type TraceQualityReadCoverage,
  type TraceQualityScore,
  type TraceQualityScoreMutationInput,
} from '../api/client';
import { analyticsFilters } from './analytics-filters.svelte';

/** The thing a new score attaches to: the selected observation, else the trace. */
export interface ScoreTarget {
  target_type: 'trace' | 'observation';
  target_id: string;
  label: string;
}

class TraceQualityStore {
  private listVersion = 0;
  private detailVersion = 0;
  private observationVersion = 0;
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
  traceScores = $state<TraceQualityScore[]>([]);
  detailLoading = $state(false);
  detailError = $state<string | null>(null);

  // Selected observation within the open trace
  selectedObservationId = $state<string | null>(null);
  observationDetail = $state<TraceQualityObservationDetail | null>(null);

  // Score mutation status
  savingScore = $state(false);
  scoreError = $state<string | null>(null);

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

  get scoreTarget(): ScoreTarget | null {
    if (this.selectedObservationId && this.observationDetail) {
      return {
        target_type: 'observation',
        target_id: this.selectedObservationId,
        label: this.observationDetail.name,
      };
    }
    if (this.detail) {
      return { target_type: 'trace', target_id: this.detail.id, label: this.detail.name };
    }
    return null;
  }

  /** Scores attached to the current score target (observation scores, else trace scores). */
  get targetScores(): TraceQualityScore[] {
    if (this.selectedObservationId && this.observationDetail) {
      return this.observationDetail.scores;
    }
    return this.traceScores;
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
    this.traceScores = [];
    this.selectedObservationId = null;
    this.observationDetail = null;
    this.detailError = null;
  }

  async loadDetail(traceId: string): Promise<void> {
    const version = ++this.detailVersion;
    this.detailLoading = true;
    this.detailError = null;
    this.selectedObservationId = null;
    this.observationDetail = null;
    try {
      const [trace, observations, scores] = await Promise.all([
        fetchTraceQualityTrace(traceId),
        fetchTraceQualityObservations(traceId),
        fetchTraceQualityScores({ target_type: 'trace', target_id: traceId }),
      ]);
      if (version !== this.detailVersion) return;
      this.detail = trace.trace;
      this.tree = observations.tree;
      this.traceScores = scores.data;
    } catch (err) {
      if (version !== this.detailVersion) return;
      console.error('Failed to load trace detail:', err);
      this.detailError = 'Failed to load trace detail.';
      this.detail = null;
      this.tree = [];
      this.traceScores = [];
    } finally {
      if (version === this.detailVersion) this.detailLoading = false;
    }
  }

  async selectObservation(observationId: string | null): Promise<void> {
    this.selectedObservationId = observationId;
    this.observationDetail = null;
    if (!observationId) return;
    const version = ++this.observationVersion;
    try {
      const result = await fetchTraceQualityObservation(observationId);
      if (version !== this.observationVersion) return;
      this.observationDetail = result.observation;
    } catch (err) {
      if (version !== this.observationVersion) return;
      console.error('Failed to load observation detail:', err);
    }
  }

  private async refreshAfterScoreChange(): Promise<void> {
    const traceId = this.detail?.id;
    if (traceId) await this.loadDetailScores(traceId);
    if (this.selectedObservationId) await this.selectObservation(this.selectedObservationId);
  }

  private async loadDetailScores(traceId: string): Promise<void> {
    const [trace, scores] = await Promise.all([
      fetchTraceQualityTrace(traceId),
      fetchTraceQualityScores({ target_type: 'trace', target_id: traceId }),
    ]);
    this.detail = trace.trace;
    this.traceScores = scores.data;
  }

  async addScore(
    input: Pick<TraceQualityScoreMutationInput, 'name' | 'value_type' | 'value' | 'comment'>,
  ): Promise<void> {
    const target = this.scoreTarget;
    if (!target || !input.name || !input.value_type) return;
    this.savingScore = true;
    this.scoreError = null;
    try {
      await createTraceQualityScore({
        target_type: target.target_type,
        target_id: target.target_id,
        name: input.name,
        value_type: input.value_type,
        value: input.value,
        comment: input.comment ?? null,
        source: 'human',
      });
      await this.refreshAfterScoreChange();
    } catch (err) {
      console.error('Failed to add score:', err);
      this.scoreError = err instanceof Error ? err.message : 'Failed to add score.';
    } finally {
      this.savingScore = false;
    }
  }

  async removeScore(id: number): Promise<void> {
    this.savingScore = true;
    this.scoreError = null;
    try {
      await deleteTraceQualityScore(id);
      await this.refreshAfterScoreChange();
    } catch (err) {
      console.error('Failed to remove score:', err);
      this.scoreError = err instanceof Error ? err.message : 'Failed to remove score.';
    } finally {
      this.savingScore = false;
    }
  }
}

export const traceQuality = new TraceQualityStore();
