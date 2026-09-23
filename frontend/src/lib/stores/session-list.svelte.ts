import { fetchBrowsingSessions, type BrowsingSession } from '../api/client';

export interface SessionListQuery {
  project: string;
  agent: string;
  /** Append the next page instead of replacing the list. */
  append?: boolean;
}

/**
 * The Sessions page list: one filtered, cursor-paged read of browsing sessions.
 * Only the newest request may write state. Filter changes and Back/Forward can
 * overlap loads, and an older response landing last would otherwise show a list
 * that no longer matches the visible filters and page from the wrong cursor.
 */
export class SessionList {
  sessions = $state<BrowsingSession[]>([]);
  total = $state(0);
  loading = $state(true);
  error = $state<string | null>(null);
  hasMore = $state(false);
  private cursor: string | undefined;
  private requestToken = 0;

  constructor(
    private readonly fetchPage: typeof fetchBrowsingSessions = fetchBrowsingSessions,
    private readonly pageSize = 25,
  ) {}

  async load({ project, agent, append = false }: SessionListQuery): Promise<void> {
    const token = ++this.requestToken;
    this.loading = true;
    this.error = null;
    try {
      const params: Record<string, string | number> = { limit: this.pageSize, exclude_empty: 'true' };
      if (project) params.project = project;
      if (agent) params.agent = agent;
      if (append && this.cursor) params.cursor = this.cursor;

      const res = await this.fetchPage(params);
      if (token !== this.requestToken) return;
      this.sessions = append ? [...this.sessions, ...res.data] : res.data;
      this.total = res.total;
      this.cursor = res.cursor;
      this.hasMore = !!res.cursor && res.data.length === this.pageSize;
    } catch (err) {
      if (token !== this.requestToken) return;
      console.error('Failed to load sessions:', err);
      this.error = 'Failed to load sessions. Check that the server is running.';
    } finally {
      if (token === this.requestToken) this.loading = false;
    }
  }
}
