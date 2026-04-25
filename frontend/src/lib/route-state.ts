export type AppTab = 'monitor' | 'live' | 'sessions' | 'pinned' | 'analytics' | 'usage' | 'insights' | 'search';

const TAB_SET = new Set<AppTab>(['monitor', 'live', 'sessions', 'pinned', 'analytics', 'usage', 'insights', 'search']);

export interface ParsedAppHash {
  tab: AppTab;
  params: URLSearchParams;
}

export interface SessionsRouteState {
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
    project: parsed.params.get('project') || '',
    agent: parsed.params.get('agent') || '',
    sessionId: parsed.params.get('session') || null,
    messageOrdinal: Number.isFinite(messageOrdinal) ? messageOrdinal : null,
  };
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
