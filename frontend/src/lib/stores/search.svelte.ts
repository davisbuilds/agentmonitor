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
import { buildSearchHash, parseSearchHash } from '../route-state';

const PAGE_SIZE = 25;
const DEFAULT_RECENT_LIMIT = 12;

interface SearchStoreOptions {
  recentLimit?: number;
  defaultSort?: SearchSort;
  syncUrl?: boolean;
}

class SearchStore {
  private initialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestVersion = 0;
  private readonly recentLimit: number;
  private readonly defaultSort: SearchSort;
  private readonly syncUrl: boolean;
  private hashListenerAttached = false;

  constructor(options: SearchStoreOptions = {}) {
    this.recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
    this.defaultSort = options.defaultSort ?? 'recent';
    this.syncUrl = options.syncUrl ?? true;
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
    if (this.syncUrl && typeof window !== 'undefined') {
      this.applyRouteState(false);
      if (!this.hashListenerAttached) {
        window.addEventListener('hashchange', this.handleHashChange);
        this.hashListenerAttached = true;
      }
    }

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
    const version = ++this.requestVersion;
    this.recentLoading = true;
    this.recentError = null;

    try {
      const res = await fetchBrowsingSessions({
        limit: this.recentLimit,
        project: this.project || undefined,
        agent: this.agent || undefined,
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

  setQuery(next: string): void {
    this.query = next;
    this.cursor = undefined;
    this.hasMore = false;
    this.error = null;
    this.syncHash();

    if (!this.hasQuery) {
      this.cancelPending();
      this.results = [];
      this.total = 0;
      this.searched = false;
      void this.refreshRecent();
      return;
    }

    this.scheduleSearch();
  }

  setProject(next: string): void {
    this.project = next;
    this.cursor = undefined;
    this.hasMore = false;
    this.syncHash();
    if (this.hasQuery) {
      this.scheduleSearch();
      return;
    }
    void this.refreshRecent();
  }

  setAgent(next: string): void {
    this.agent = next;
    this.cursor = undefined;
    this.hasMore = false;
    this.syncHash();
    if (this.hasQuery) {
      this.scheduleSearch();
      return;
    }
    void this.refreshRecent();
  }

  setSort(next: SearchSort): void {
    this.sort = next;
    this.cursor = undefined;
    this.hasMore = false;
    this.syncHash();
    if (this.hasQuery) {
      this.scheduleSearch();
    }
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
    if (this.hashListenerAttached && typeof window !== 'undefined') {
      window.removeEventListener('hashchange', this.handleHashChange);
      this.hashListenerAttached = false;
    }
  }

  private scheduleSearch(): void {
    this.cancelPending();
    this.debounceTimer = setTimeout(() => {
      void this.searchNow(false);
    }, 220);
  }

  private syncHash(): void {
    if (!this.syncUrl || typeof window === 'undefined') return;
    const nextHash = buildSearchHash({
      query: this.query,
      project: this.project,
      agent: this.agent,
      sort: this.sort,
    });
    const nextUrl = `${window.location.pathname}${window.location.search}#${nextHash}`;
    window.history.replaceState(null, '', nextUrl);
  }

  private applyRouteState(shouldFetch: boolean): void {
    if (!this.syncUrl || typeof window === 'undefined') return;
    const next = parseSearchHash(window.location.hash, {
      query: this.query,
      project: this.project,
      agent: this.agent,
      sort: this.defaultSort,
    });
    const changed = (
      next.query !== this.query
      || next.project !== this.project
      || next.agent !== this.agent
      || next.sort !== this.sort
    );
    if (!changed) return;

    this.cancelPending();
    this.query = next.query;
    this.project = next.project;
    this.agent = next.agent;
    this.sort = next.sort;
    this.cursor = undefined;
    this.hasMore = false;
    this.error = null;

    if (!shouldFetch) return;
    if (this.hasQuery) {
      void this.searchNow(false);
      return;
    }
    this.results = [];
    this.total = 0;
    this.searched = false;
    void this.refreshRecent();
  }

  private readonly handleHashChange = (): void => {
    this.applyRouteState(true);
  };
}

export function createSearchStore(options?: SearchStoreOptions): SearchStore {
  return new SearchStore(options);
}

export const search = createSearchStore();
export const commandPaletteSearch = createSearchStore({ recentLimit: 10, syncUrl: false });
