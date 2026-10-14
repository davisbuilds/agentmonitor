export type AppTab = 'monitor' | 'sessions' | 'analytics' | 'benchmarks';

const TAB_SET = new Set<AppTab>(['monitor', 'sessions', 'analytics', 'benchmarks']);

/** Sub-views inside the consolidated Analytics tab. */
export type AnalyticsView = 'overview' | 'usage' | 'skills' | 'insights' | 'quality';
export type AnalyticsSkillSignal =
  | 'all'
  | 'first_read'
  | 'rehydrated'
  | 'presented_unread'
  | 'unclassified';
export type AnalyticsSkillSort =
  | 'volume'
  | 'first_read_rate'
  | 'rehydrations'
  | 'name';

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
  // Skills sub-view specialized filters.
  skillHarness: string;
  skillQuery: string;
  skillSignal: AnalyticsSkillSignal;
  skillSort: AnalyticsSkillSort;
  // Insights sub-view specialized filters (provider/model here mean the LLM that
  // authors the insight, distinct from Usage's billed provider/model).
  insightProvider: string;
  insightModel: string;
  kind: string;
  // Quality sub-view: optional session scope (drill-in) and the open trace.
  sessionId: string | null;
  traceId: string | null;
}

export type SessionsSearchSort = 'recent' | 'relevance';

/**
 * The Sessions tab: a session list that a query turns into full-text message
 * results and the Pinned filter turns into pinned messages, plus the open
 * session (and message) when the viewer is showing.
 */
export interface SessionsRouteState {
  query: string;
  sort: SessionsSearchSort;
  project: string;
  agent: string;
  pinned: boolean;
  sessionId: string | null;
  messageOrdinal: number | null;
}

export function defaultSessionsRouteState(): SessionsRouteState {
  return {
    query: '',
    sort: 'recent',
    project: '',
    agent: '',
    pinned: false,
    sessionId: null,
    messageOrdinal: null,
  };
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
  // Sort orders full-text results only: no query, or pinned messages (which
  // keep their own order), leave it out of the link.
  const ordersResults = state.query.trim() !== '' && !state.pinned;
  return buildAppHash('sessions', {
    q: state.query,
    project: state.project,
    agent: state.agent,
    sort: ordersResults && state.sort === 'relevance' ? 'relevance' : null,
    pinned: state.pinned ? 1 : null,
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
    query: parsed.params.get('q') || '',
    sort: parsed.params.get('sort') === 'relevance' ? 'relevance' : 'recent',
    project: parsed.params.get('project') || '',
    agent: parsed.params.get('agent') || '',
    pinned: parsed.params.get('pinned') === '1',
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
  } else if (state.view === 'skills') {
    if (state.skillHarness) params.set('harness', state.skillHarness);
    if (state.skillQuery) params.set('skill', state.skillQuery);
    if (state.skillSignal !== 'all') params.set('signal', state.skillSignal);
    if (state.skillSort !== 'volume') params.set('sort', state.skillSort);
  } else if (state.view === 'insights') {
    if (state.insightProvider) params.set('provider', state.insightProvider);
    if (state.insightModel) params.set('model', state.insightModel);
    if (state.kind) params.set('kind', state.kind);
  } else if (state.view === 'quality') {
    if (state.sessionId) params.set('session', state.sessionId);
    if (state.traceId) params.set('trace', state.traceId);
  }

  const suffix = params.toString();
  return suffix ? `analytics?${suffix}` : 'analytics';
}

/** Hash href for drilling into the Quality explorer, optionally scoped to a session/trace. */
export function buildAnalyticsQualityHash(opts: { sessionId?: string | null; traceId?: string | null } = {}): string {
  const params = new URLSearchParams();
  params.set('view', 'quality');
  if (opts.sessionId) params.set('session', opts.sessionId);
  if (opts.traceId) params.set('trace', opts.traceId);
  return `analytics?${params.toString()}`;
}

export function parseAnalyticsRouteHash(hash: string, fallback: AnalyticsRouteState): AnalyticsRouteState {
  const parsed = parseAppHash(hash);
  if (parsed.tab !== 'analytics') return fallback;

  const params = parsed.params;
  const rawView = params.get('view');
  const view: AnalyticsView = rawView === 'usage'
    || rawView === 'skills'
    || rawView === 'insights'
    || rawView === 'quality'
    ? rawView
    : 'overview';
  const rawSkillSignal = params.get('signal');
  const skillSignal: AnalyticsSkillSignal = rawSkillSignal === 'first_read'
    || rawSkillSignal === 'rehydrated'
    || rawSkillSignal === 'presented_unread'
    || rawSkillSignal === 'unclassified'
    ? rawSkillSignal
    : 'all';
  const rawSkillSort = params.get('sort');
  const skillSort: AnalyticsSkillSort = rawSkillSort === 'first_read_rate'
    || rawSkillSort === 'rehydrations'
    || rawSkillSort === 'name'
    ? rawSkillSort
    : 'volume';

  return {
    view,
    from: params.get('from') || fallback.from,
    to: params.get('to') || fallback.to,
    project: params.get('project') || '',
    agent: params.get('agent') || '',
    model: view === 'usage' ? params.get('model') || '' : '',
    provider: view === 'usage' ? params.get('provider') || '' : '',
    tier: view === 'usage' ? params.get('tier') || '' : '',
    skillHarness: view === 'skills' ? params.get('harness') || '' : '',
    skillQuery: view === 'skills' ? params.get('skill') || '' : '',
    skillSignal: view === 'skills' ? skillSignal : 'all',
    skillSort: view === 'skills' ? skillSort : 'volume',
    insightProvider: view === 'insights' ? params.get('provider') || '' : fallback.insightProvider,
    insightModel: view === 'insights' ? params.get('model') || '' : '',
    kind: view === 'insights' ? params.get('kind') || '' : fallback.kind,
    sessionId: view === 'quality' ? params.get('session') || null : null,
    traceId: view === 'quality' ? params.get('trace') || null : null,
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
 * Rewrite a legacy Pinned deep link — the old top-level `#pinned` tab or the
 * old `#sessions?view=pinned` sub-view — into the canonical Pinned filter,
 * `#sessions?pinned=1`. Returns null when no rewrite is needed.
 */
export function canonicalizeLegacyPinnedHash(hash: string): string | null {
  const normalized = normalizeHash(hash);
  const [rawTab = '', query = ''] = normalized.split('?');
  const params = new URLSearchParams(query);
  if (rawTab === 'pinned') {
    return buildSessionsHash({ ...defaultSessionsRouteState(), pinned: true });
  }
  if (rawTab !== 'sessions' || params.get('view') !== 'pinned') return null;
  params.delete('view');
  return buildSessionsHash({
    ...parseSessionsHash(`sessions?${params.toString()}`, defaultSessionsRouteState()),
    pinned: true,
  });
}

/**
 * Rewrite a legacy `#search?…` deep link (the Search tab folded into Sessions)
 * into the canonical `#sessions?q=…` form. Returns null when no rewrite is needed.
 */
export function canonicalizeLegacySearchHash(hash: string): string | null {
  const normalized = normalizeHash(hash);
  const [rawTab = '', query = ''] = normalized.split('?');
  if (rawTab !== 'search') return null;
  // The old Search params (q, project, agent, sort) keep their names.
  return buildSessionsHash(parseSessionsHash(`sessions?${query}`, defaultSessionsRouteState()));
}

/**
 * Monitor's drill-in: an agent card opens that session's live stream at
 * `#monitor?session=…`. Without a session the Monitor hash stays empty.
 */
export function buildMonitorHash(sessionId: string | null): string {
  if (!sessionId) return '';
  return `monitor?${new URLSearchParams({ session: sessionId }).toString()}`;
}

export function parseMonitorSessionId(hash: string): string | null {
  const [rawTab = '', query = ''] = normalizeHash(hash).split('?');
  if (rawTab !== 'monitor') return null;
  return new URLSearchParams(query).get('session') || null;
}

/**
 * Rewrite a legacy `#live` deep link to Monitor, which now holds the live
 * stream. Returns null when no rewrite is needed.
 */
export function canonicalizeLegacyLiveHash(hash: string): string | null {
  const [rawTab = ''] = normalizeHash(hash).split('?');
  return rawTab === 'live' ? '' : null;
}
