import {
  fetchBrowsingSessions,
  fetchV2Projects,
  fetchV2Agents,
  searchMessages,
  type BrowsingSession,
  type SearchResult,
  type SearchSort,
} from '../api/client';
import { navigateToSession, navigateToSessionMessage } from './router.svelte';

const PAGE_SIZE = 25;
const DEFAULT_RECENT_LIMIT = 12;

interface SearchStoreOptions {
  /** Recent sessions shown while there is no query; 0 never loads them. */
  recentLimit?: number;
  defaultSort?: SearchSort;
}

export interface SearchState {
  query: string;
  project: string;
  agent: string;
  sort: SearchSort;
}

class SearchStore {
  private initialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestVersion = 0;
  private readonly recentLimit: number;
  private readonly defaultSort: SearchSort;

  constructor(options: SearchStoreOptions = {}) {
    this.recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
    this.defaultSort = options.defaultSort ?? 'recent';
    this.sort = this.defaultSort;
  }

  query = $state('');
  project = $state('');
  agent = $state('');
  sort = $state<SearchSort>('recent');

  projectOptions = $state<string[]>([]);
  agentOptions = $state<string[]>([]);

  results = $state<SearchResult[]>([]);
  recentSessions = $state<BrowsingSession[]>([]);
  total = $state(0);
  searched = $state(false);
  cursor = $state<string | undefined>(undefined);
  hasMore = $state(false);

  loading = $state(false);
  recentLoading = $state(false);
  error = $state<string | null>(null);
  recentError = $state<string | null>(null);

  get hasQuery(): boolean {
    return this.query.trim().length > 0;
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

    if (this.hasQuery) {
      await this.searchNow(false);
      return;
    }

    await this.refreshRecent();
  }

  cancelPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  async refreshRecent(): Promise<void> {
    if (this.recentLimit <= 0) return;
    const version = ++this.requestVersion;
    this.recentLoading = true;
    this.recentError = null;

    try {
      const res = await fetchBrowsingSessions({
        limit: this.recentLimit,
        project: this.project || undefined,
        agent: this.agent || undefined,
        // Like the Sessions list: a session with no transcript has nothing to open.
        exclude_empty: 'true',
      });
      if (version !== this.requestVersion) return;
      this.recentSessions = res.data;
    } catch (err) {
      if (version !== this.requestVersion) return;
      console.error('Failed to load recent sessions:', err);
      this.recentError = 'Failed to load recent sessions.';
    } finally {
      if (version === this.requestVersion) {
        this.recentLoading = false;
      }
    }
  }

  /**
   * Replace the query, filters and sort at once. A query searches after a
   * short pause, or right away with `immediate`; no query clears the results.
   */
  update(next: Partial<SearchState>, { immediate = false }: { immediate?: boolean } = {}): void {
    if (next.query !== undefined) this.query = next.query;
    if (next.project !== undefined) this.project = next.project;
    if (next.agent !== undefined) this.agent = next.agent;
    if (next.sort !== undefined) this.sort = next.sort;
    this.cursor = undefined;
    this.hasMore = false;
    this.error = null;

    if (!this.hasQuery) {
      this.cancelPending();
      // A search still in flight must not land on the cleared results.
      this.requestVersion += 1;
      this.loading = false;
      this.results = [];
      this.total = 0;
      this.searched = false;
      void this.refreshRecent();
      return;
    }

    if (immediate) {
      void this.searchNow(false);
      return;
    }
    this.scheduleSearch();
  }

  setQuery(next: string): void {
    this.update({ query: next });
  }

  setSort(next: SearchSort): void {
    this.update({ sort: next });
  }

  async searchNow(append = false): Promise<void> {
    this.cancelPending();

    if (!this.hasQuery) {
      await this.refreshRecent();
      return;
    }

    const version = ++this.requestVersion;
    this.loading = true;
    this.error = null;
    if (!append) {
      this.searched = true;
    }

    try {
      const res = await searchMessages({
        q: this.query.trim(),
        project: this.project || undefined,
        agent: this.agent || undefined,
        sort: this.sort,
        limit: PAGE_SIZE,
        cursor: append ? this.cursor : undefined,
      });
      if (version !== this.requestVersion) return;
      this.results = append ? [...this.results, ...res.data] : res.data;
      this.total = res.total;
      this.cursor = res.cursor;
      this.hasMore = Boolean(res.cursor) && res.data.length === PAGE_SIZE;
    } catch (err) {
      if (version !== this.requestVersion) return;
      console.error('Search failed:', err);
      this.error = err instanceof Error && err.message.includes('400')
        ? 'Invalid search syntax. Avoid unmatched quotes or malformed operators.'
        : 'Search failed. Check that the server is running.';
    } finally {
      if (version === this.requestVersion) {
        this.loading = false;
      }
    }
  }

  async loadMore(): Promise<void> {
    if (!this.hasQuery || !this.hasMore || this.loading) return;
    await this.searchNow(true);
  }

  openResult(result: SearchResult): void {
    navigateToSessionMessage(result.session_id, result.message_ordinal);
  }

  openSession(sessionId: string): void {
    navigateToSession(sessionId);
  }

  reset(): void {
    this.cancelPending();
    this.requestVersion += 1;
    this.query = '';
    this.sort = this.defaultSort;
    this.results = [];
    this.total = 0;
    this.searched = false;
    this.cursor = undefined;
    this.hasMore = false;
    this.loading = false;
    this.error = null;
    this.recentError = null;
  }

  dispose(): void {
    this.cancelPending();
    this.requestVersion += 1;
  }

  private scheduleSearch(): void {
    this.cancelPending();
    this.debounceTimer = setTimeout(() => {
      void this.searchNow(false);
    }, 220);
  }
}

export type { SearchStore };

export function createSearchStore(options?: SearchStoreOptions): SearchStore {
  return new SearchStore(options);
}

export const commandPaletteSearch = createSearchStore({ recentLimit: 10 });
