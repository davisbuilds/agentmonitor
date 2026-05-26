export type AppTab = 'monitor' | 'live' | 'sessions' | 'analytics' | 'search';

const TAB_SET = new Set<AppTab>(['monitor', 'live', 'sessions', 'analytics', 'search']);

/** Sub-views inside the consolidated Analytics tab. */
export type AnalyticsView = 'overview' | 'usage' | 'insights';

/** Sub-views inside the Sessions tab (Pinned folded in). */
export type SessionsView = 'browse' | 'pinned';

export interface ParsedAppHash {
  tab: AppTab;
  params: URLSearchParams;
}

export interface AnalyticsRouteState {
  view: AnalyticsView;
  from: string;
  to: string;
  project: string;
  agent: string;
  // Usage sub-view specialized filters.
  model: string;
  provider: string;
  tier: string;
  // Insights sub-view specialized filters (provider/model here mean the LLM that
  // authors the insight, distinct from Usage's billed provider/model).
  insightProvider: string;
  insightModel: string;
  kind: string;
}

export interface SessionsRouteState {
  view: SessionsView;
  project: string;
  agent: string;
  sessionId: string | null;
  messageOrdinal: number | null;
}

export interface SearchRouteState {
  query: string;
  project: string;
  agent: string;
  sort: 'recent' | 'relevance';
}

function normalizeHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

export function parseAppHash(hash: string): ParsedAppHash {
  const normalized = normalizeHash(hash);
  const [rawTab = '', query = ''] = normalized.split('?');
  const tab = TAB_SET.has(rawTab as AppTab) ? rawTab as AppTab : 'monitor';
  return {
    tab,
    params: new URLSearchParams(query),
  };
}

export function buildAppHash(tab: AppTab, params: URLSearchParams | Record<string, string | number | null | undefined> = {}): string {
  if (tab === 'monitor') return '';

  const query = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      query.set(key, String(value));
    }
  }

  const suffix = query.toString();
  return suffix ? `${tab}?${suffix}` : tab;
}

export function buildSessionsHash(state: SessionsRouteState): string {
  // The Pinned sub-view has no session/filter state; Browse carries the rest.
  if (state.view === 'pinned') {
    return buildAppHash('sessions', { view: 'pinned' });
  }
  return buildAppHash('sessions', {
    project: state.project,
    agent: state.agent,
    session: state.sessionId,
    message: state.messageOrdinal,
  });
}

export function parseSessionsHash(hash: string, fallback: SessionsRouteState): SessionsRouteState {
  const parsed = parseAppHash(hash);
  if (parsed.tab !== 'sessions') return fallback;

  const rawMessage = parsed.params.get('message');
  const messageOrdinal = rawMessage == null ? null : Number.parseInt(rawMessage, 10);

  return {
    view: parsed.params.get('view') === 'pinned' ? 'pinned' : 'browse',
    project: parsed.params.get('project') || '',
    agent: parsed.params.get('agent') || '',
    sessionId: parsed.params.get('session') || null,
    messageOrdinal: Number.isFinite(messageOrdinal) ? messageOrdinal : null,
  };
}

export function buildAnalyticsRouteHash(state: AnalyticsRouteState): string {
  const params = new URLSearchParams();
  if (state.view !== 'overview') params.set('view', state.view);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.project) params.set('project', state.project);
  if (state.agent) params.set('agent', state.agent);

  if (state.view === 'usage') {
    if (state.model) params.set('model', state.model);
    if (state.provider) params.set('provider', state.provider);
    if (state.tier) params.set('tier', state.tier);
  } else if (state.view === 'insights') {
    if (state.insightProvider) params.set('provider', state.insightProvider);
    if (state.insightModel) params.set('model', state.insightModel);
    if (state.kind) params.set('kind', state.kind);
  }

  const suffix = params.toString();
  return suffix ? `analytics?${suffix}` : 'analytics';
}

export function parseAnalyticsRouteHash(hash: string, fallback: AnalyticsRouteState): AnalyticsRouteState {
  const parsed = parseAppHash(hash);
  if (parsed.tab !== 'analytics') return fallback;

  const params = parsed.params;
  const rawView = params.get('view');
  const view: AnalyticsView = rawView === 'usage' || rawView === 'insights' ? rawView : 'overview';

  return {
    view,
    from: params.get('from') || fallback.from,
    to: params.get('to') || fallback.to,
    project: params.get('project') || '',
    agent: params.get('agent') || '',
    model: view === 'usage' ? params.get('model') || '' : '',
    provider: view === 'usage' ? params.get('provider') || '' : '',
    tier: view === 'usage' ? params.get('tier') || '' : '',
    insightProvider: view === 'insights' ? params.get('provider') || '' : fallback.insightProvider,
    insightModel: view === 'insights' ? params.get('model') || '' : '',
    kind: view === 'insights' ? params.get('kind') || '' : fallback.kind,
  };
}

/**
 * Rewrite a legacy top-level `#usage`/`#insights` deep link into the canonical
 * `#analytics?view=…` form. Returns null when no rewrite is needed (already
 * canonical, or an unrelated hash).
 */
export function canonicalizeLegacyAnalyticsHash(hash: string): string | null {
  const normalized = normalizeHash(hash);
  const [rawTab = '', query = ''] = normalized.split('?');
  if (rawTab !== 'usage' && rawTab !== 'insights') return null;

  const params = new URLSearchParams(query);
  params.set('view', rawTab);
  return `analytics?${params.toString()}`;
}

/**
 * Rewrite a legacy top-level `#pinned` deep link into the canonical
 * `#sessions?view=pinned` form. Returns null when no rewrite is needed.
 */
export function canonicalizeLegacyPinnedHash(hash: string): string | null {
  const normalized = normalizeHash(hash);
  const [rawTab = ''] = normalized.split('?');
  if (rawTab !== 'pinned') return null;
  return 'sessions?view=pinned';
}

export function buildSearchHash(state: SearchRouteState): string {
  return buildAppHash('search', {
    q: state.query,
    project: state.project,
    agent: state.agent,
    sort: state.sort === 'recent' ? null : state.sort,
  });
}

export function parseSearchHash(hash: string, fallback: SearchRouteState): SearchRouteState {
  const parsed = parseAppHash(hash);
  if (parsed.tab !== 'search') return fallback;

  const sort = parsed.params.get('sort');
  return {
    query: parsed.params.get('q') || '',
    project: parsed.params.get('project') || '',
    agent: parsed.params.get('agent') || '',
    sort: sort === 'relevance' ? 'relevance' : fallback.sort,
  };
}
