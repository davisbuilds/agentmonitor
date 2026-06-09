import {
  fetchTraceQualityTraces,
  fetchTraceQualityTrace,
  fetchTraceQualityObservations,
  fetchTraceQualityObservation,
  fetchTraceQualityScores,
  fetchTraceQualityFindings,
  fetchTraceQualityPrompts,
  fetchTraceQualityScoreSummary,
  fetchTraceQualityScoreRollups,
  createTraceQualityScore,
  deleteTraceQualityScore,
  type TraceQualityTrace,
  type TraceQualityTraceDetail,
  type TraceQualityObservationTreeNode,
  type TraceQualityObservationDetail,
  type TraceQualityReadCoverage,
  type TraceQualityScore,
  type TraceQualityScoreMutationInput,
  type TraceQualityFinding,
  type TraceQualityFindingKind,
  type TraceQualityFindingSeverity,
  type TraceQualityPromptRollup,
  type TraceQualityScoreSummary,
  type TraceQualityScoreRollups,
} from '../api/client';
import { analyticsFilters } from './analytics-filters.svelte';

/** Which surface of the Quality view is showing: per-trace explorer or aggregate dashboards. */
export type QualityPanel = 'explorer' | 'dashboards';

/** Empty rollups keyed by every dimension, used before dashboards load. */
const EMPTY_ROLLUPS: TraceQualityScoreRollups = {
  trace: [], session: [], model: [], tool: [], prompt: [], day: [],
};

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
  private dashboardVersion = 0;
  private findingsVersion = 0;
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

  // Dashboards (aggregate findings / prompt rollups / score trends)
  panel = $state<QualityPanel>('explorer');
  findings = $state<TraceQualityFinding[]>([]);
  prompts = $state<TraceQualityPromptRollup[]>([]);
  scoreSummary = $state<TraceQualityScoreSummary[]>([]);
  scoreRollups = $state<TraceQualityScoreRollups>(EMPTY_ROLLUPS);
  dashboardsLoading = $state(false);
  dashboardsLoaded = $state(false);
  dashboardsError = $state<string | null>(null);
  findingsLoading = $state(false);
  findingKind = $state<TraceQualityFindingKind | ''>('');
  findingSeverity = $state<TraceQualityFindingSeverity | ''>('');

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

  /**
   * Human-authored scores on the current target (observation scores, else trace
   * scores). Generated rows (`code_evaluator`/`llm_judge`/`api`/`system`) are
   * excluded: this is the local human-review surface and its Remove action calls
   * the destructive delete endpoint, so it must not expose machine-written scores
   * for accidental deletion. Generated scores surface in the Quality dashboards.
   */
  get targetScores(): TraceQualityScore[] {
    const scores = this.selectedObservationId && this.observationDetail
      ? this.observationDetail.scores
      : this.traceScores;
    return scores.filter((score) => score.source === 'human');
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
        // Keep aggregate dashboards in sync with the shared filter bar once loaded.
        if (this.dashboardsLoaded) void this.loadDashboards();
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

  // --- Dashboards (aggregate findings / prompt rollups / score trends) ---

  /** Dashboards aggregate over the shared date/project/agent window; session scope
   *  is an explorer concern and does not apply here. */
  private get dashboardParams(): Record<string, string> {
    const params: Record<string, string> = { date_from: this.from, date_to: this.to };
    if (this.project) params.project = this.project;
    if (this.agent) params.agent = this.agent;
    return params;
  }

  private get findingParams(): Record<string, string> {
    const params = this.dashboardParams;
    if (this.findingKind) params.kind = this.findingKind;
    if (this.findingSeverity) params.severity = this.findingSeverity;
    return params;
  }

  /** Switch the Quality view surface; lazily load dashboards the first time they show. */
  setPanel(panel: QualityPanel): void {
    this.panel = panel;
    if (panel === 'dashboards' && !this.dashboardsLoaded) void this.loadDashboards();
  }

  async loadDashboards(): Promise<void> {
    const version = ++this.dashboardVersion;
    // `findings` is also written by loadFindings(); share its guard so a slow
    // aggregate load can't clobber a newer findings-filter result (or vice-versa).
    const findingsVersion = ++this.findingsVersion;
    this.dashboardsLoading = true;
    this.dashboardsError = null;
    try {
      const [findings, prompts, summary, rollups] = await Promise.all([
        fetchTraceQualityFindings(this.findingParams),
        fetchTraceQualityPrompts(this.dashboardParams),
        fetchTraceQualityScoreSummary(this.dashboardParams),
        fetchTraceQualityScoreRollups(this.dashboardParams),
      ]);
      if (findingsVersion === this.findingsVersion) this.findings = findings.data;
      if (version === this.dashboardVersion) {
        this.prompts = prompts.data;
        this.scoreSummary = summary.data;
        this.scoreRollups = rollups.data;
        this.dashboardsLoaded = true;
      }
    } catch (err) {
      if (version !== this.dashboardVersion) return;
      console.error('Failed to load quality dashboards:', err);
      this.dashboardsError = 'Failed to load quality dashboards.';
    } finally {
      if (version === this.dashboardVersion) this.dashboardsLoading = false;
    }
  }

  /** Reload only findings (cheaper than the full dashboard) when a finding filter changes. */
  async loadFindings(): Promise<void> {
    const version = ++this.findingsVersion;
    this.findingsLoading = true;
    try {
      const findings = await fetchTraceQualityFindings(this.findingParams);
      if (version !== this.findingsVersion) return;
      this.findings = findings.data;
    } catch (err) {
      if (version !== this.findingsVersion) return;
      console.error('Failed to load findings:', err);
    } finally {
      if (version === this.findingsVersion) this.findingsLoading = false;
    }
  }

  setFindingKind(kind: TraceQualityFindingKind | ''): void {
    this.findingKind = kind;
    void this.loadFindings();
  }

  setFindingSeverity(severity: TraceQualityFindingSeverity | ''): void {
    this.findingSeverity = severity;
    void this.loadFindings();
  }

  /** A finding can be inspected when it points at a concrete trace or session. */
  canInspect(finding: TraceQualityFinding): boolean {
    return Boolean(
      finding.trace_id
      || finding.evidence.impacted_trace_ids?.length
      || finding.evidence.impacted_session_ids?.length,
    );
  }

  /** Jump from a dashboard finding into the explorer, opening its trace or session. */
  inspectFinding(finding: TraceQualityFinding): void {
    this.panel = 'explorer';
    const traceId = finding.trace_id ?? finding.evidence.impacted_trace_ids?.[0] ?? null;
    if (traceId) {
      void this.selectTrace(traceId);
      return;
    }
    const sessionId = finding.evidence.impacted_session_ids?.[0] ?? null;
    if (sessionId) analyticsFilters.setSessionScope(sessionId);
  }
}

export const traceQuality = new TraceQualityStore();
