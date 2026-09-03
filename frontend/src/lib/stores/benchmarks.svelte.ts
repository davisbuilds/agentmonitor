import {
  fetchBenchmarkStudies,
  fetchBenchmarkStudy,
  type BenchmarkStudySummary,
  type BenchmarkStudyDetail,
} from '../api/client';
import { buildAppHash, parseAppHash } from '../route-state';

/**
 * Benchmarks tab state: the studies list plus the currently-selected study's
 * per-arm detail. The selected study rides `#benchmarks?study=<study_id>`, kept
 * in sync via replaceState (list↔detail is not a history step; an explicit
 * in-page Back returns to the list).
 */
class BenchmarksStore {
  studies = $state<BenchmarkStudySummary[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  selectedStudyId = $state<string | null>(null);
  detail = $state<BenchmarkStudyDetail | null>(null);
  detailLoading = $state(false);
  detailError = $state<string | null>(null);
  /** Bumped per detail request; a slower earlier response is discarded. */
  private detailRequest = 0;

  async loadStudies(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.studies = (await fetchBenchmarkStudies()).data;
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load benchmark studies';
    } finally {
      this.loading = false;
    }
  }

  async select(studyId: string | null): Promise<void> {
    this.selectedStudyId = studyId;
    this.writeHash(studyId);
    const req = ++this.detailRequest;
    if (!studyId) {
      this.detail = null;
      this.detailError = null;
      this.detailLoading = false;
      return;
    }
    this.detailLoading = true;
    this.detailError = null;
    try {
      const detail = await fetchBenchmarkStudy(studyId);
      if (req !== this.detailRequest) return; // a newer selection superseded this one
      this.detail = detail;
    } catch (err) {
      if (req !== this.detailRequest) return;
      this.detailError = err instanceof Error ? err.message : 'Failed to load study';
      this.detail = null;
    } finally {
      if (req === this.detailRequest) this.detailLoading = false;
    }
  }

  /** Read the selected study from the URL and load it if it changed. */
  syncFromHash(): void {
    if (typeof window === 'undefined') return;
    const parsed = parseAppHash(window.location.hash);
    const studyId = parsed.tab === 'benchmarks' ? parsed.params.get('study') : null;
    if (studyId !== this.selectedStudyId) void this.select(studyId);
  }

  private writeHash(studyId: string | null): void {
    if (typeof window === 'undefined') return;
    const hash = studyId ? buildAppHash('benchmarks', { study: studyId }) : 'benchmarks';
    const next = `#${hash}`;
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  }
}

export const benchmarksStore = new BenchmarksStore();
