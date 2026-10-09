import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalyticsQualityHash,
  buildAnalyticsRouteHash,
  buildAppHash,
  buildSearchHash,
  buildSessionsHash,
  canonicalizeLegacyAnalyticsHash,
  canonicalizeLegacyPinnedHash,
  parseAnalyticsRouteHash,
  parseAppHash,
  parseSearchHash,
  parseSessionsHash,
  type AnalyticsRouteState,
} from '../frontend/src/lib/route-state.ts';

const analyticsFallback: AnalyticsRouteState = {
  view: 'overview',
  from: '2026-01-01',
  to: '2026-01-30',
  project: '',
  agent: '',
  model: '',
  provider: '',
  tier: '',
  skillHarness: '',
  skillQuery: '',
  skillSignal: 'all',
  skillSort: 'volume',
  insightProvider: 'openai',
  insightModel: '',
  kind: '',
  sessionId: null,
  traceId: null,
};

test('parseAppHash defaults to monitor and preserves query params', () => {
  assert.deepEqual(parseAppHash(''), {
    tab: 'monitor',
    params: new URLSearchParams(),
  });

  const parsed = parseAppHash('#sessions?session=abc&message=42');
  assert.equal(parsed.tab, 'sessions');
  assert.equal(parsed.params.get('session'), 'abc');
  assert.equal(parsed.params.get('message'), '42');
});

test('buildAppHash omits monitor hash and serializes params', () => {
  assert.equal(buildAppHash('monitor'), '');
  assert.equal(buildAppHash('search', { q: 'quota reset', project: 'agentmonitor' }), 'search?q=quota+reset&project=agentmonitor');
});

test('benchmarks is a routable tab that carries a selected study', () => {
  assert.equal(parseAppHash('#benchmarks').tab, 'benchmarks');
  assert.equal(buildAppHash('benchmarks', { study: 'sha-abc' }), 'benchmarks?study=sha-abc');
  const parsed = parseAppHash('#benchmarks?study=sha-abc');
  assert.equal(parsed.tab, 'benchmarks');
  assert.equal(parsed.params.get('study'), 'sha-abc');
});

test('sessions hashes round-trip selected session and filters', () => {
  const state = {
    view: 'browse' as const,
    project: 'agentmonitor',
    agent: 'codex',
    sessionId: 'session-123',
    messageOrdinal: 17,
  };

  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?project=agentmonitor&agent=codex&session=session-123&message=17');
  assert.deepEqual(parseSessionsHash(`#${hash}`, {
    view: 'browse',
    project: '',
    agent: '',
    sessionId: null,
    messageOrdinal: null,
  }), state);
});

test('parseSessionsHash ignores invalid message ordinals and non-session hashes', () => {
  const fallback = {
    view: 'browse' as const,
    project: 'fallback',
    agent: '',
    sessionId: null,
    messageOrdinal: null,
  };

  assert.deepEqual(parseSessionsHash('#search?q=test', fallback), fallback);
  assert.deepEqual(parseSessionsHash('#sessions?session=abc&message=nope', fallback), {
    view: 'browse',
    project: '',
    agent: '',
    sessionId: 'abc',
    messageOrdinal: null,
  });
});

test('Pinned folds into Sessions as a sub-view', () => {
  // No longer a standalone tab; canonicalized into the Sessions tab.
  assert.equal(parseAppHash('#pinned').tab, 'monitor');
  assert.equal(canonicalizeLegacyPinnedHash('#pinned'), 'sessions?view=pinned');
  assert.equal(canonicalizeLegacyPinnedHash('#sessions?view=pinned'), null);
  assert.equal(canonicalizeLegacyPinnedHash('#analytics'), null);

  // The Pinned sub-view serializes view=pinned and drops browse-only state.
  assert.equal(
    buildSessionsHash({ view: 'pinned', project: 'x', agent: 'y', sessionId: 's', messageOrdinal: 3 }),
    'sessions?view=pinned',
  );
  const pinned = parseSessionsHash('#sessions?view=pinned', {
    view: 'browse', project: '', agent: '', sessionId: null, messageOrdinal: null,
  });
  assert.equal(pinned.view, 'pinned');
});

test('search hashes round-trip query, filters, and non-default sort', () => {
  const state = {
    query: 'token usage',
    project: 'agentmonitor',
    agent: 'claude_code',
    sort: 'relevance' as const,
  };

  const hash = buildSearchHash(state);
  assert.equal(hash, 'search?q=token+usage&project=agentmonitor&agent=claude_code&sort=relevance');
  assert.deepEqual(parseSearchHash(`#${hash}`, {
    query: '',
    project: '',
    agent: '',
    sort: 'recent',
  }), state);
});

test('usage and insights are no longer standalone tabs', () => {
  // Legacy top-level tabs collapse into the analytics tab via canonicalization.
  assert.equal(parseAppHash('#usage?from=2026-01-01').tab, 'monitor');
  assert.equal(parseAppHash('#insights').tab, 'monitor');
  assert.equal(parseAppHash('#analytics?view=usage').tab, 'analytics');
});

test('canonicalizeLegacyAnalyticsHash rewrites old usage/insights deep links', () => {
  assert.equal(
    canonicalizeLegacyAnalyticsHash('#usage?from=2026-01-01&to=2026-01-30&project=p&model=gpt-5&tier=standard'),
    'analytics?from=2026-01-01&to=2026-01-30&project=p&model=gpt-5&tier=standard&view=usage',
  );
  assert.equal(canonicalizeLegacyAnalyticsHash('#insights'), 'analytics?view=insights');
  // Already-canonical or unrelated hashes are left alone.
  assert.equal(canonicalizeLegacyAnalyticsHash('#analytics?view=usage'), null);
  assert.equal(canonicalizeLegacyAnalyticsHash('#sessions?session=abc'), null);
  assert.equal(canonicalizeLegacyAnalyticsHash(''), null);
});

test('analytics route hashes round-trip view + shared filters', () => {
  // Overview view omits the view param; shared filters serialize.
  assert.equal(
    buildAnalyticsRouteHash({ ...analyticsFallback, view: 'overview', from: '2026-02-01', to: '2026-02-28', project: 'am' }),
    'analytics?from=2026-02-01&to=2026-02-28&project=am',
  );
  const overview = parseAnalyticsRouteHash('#analytics?from=2026-02-01&to=2026-02-28&project=am', analyticsFallback);
  assert.equal(overview.view, 'overview');
  assert.equal(overview.from, '2026-02-01');
  assert.equal(overview.project, 'am');
});

test('analytics route hashes carry only the active view\'s specialized filters', () => {
  // Usage view: model/provider/tier serialize; insights fields do not.
  const usageHash = buildAnalyticsRouteHash({
    ...analyticsFallback, view: 'usage', model: 'gpt-5', provider: 'openai', tier: 'standard', insightModel: 'ignored',
  });
  assert.equal(usageHash, 'analytics?view=usage&from=2026-01-01&to=2026-01-30&model=gpt-5&provider=openai&tier=standard');
  const usage = parseAnalyticsRouteHash(`#${usageHash}`, analyticsFallback);
  assert.equal(usage.view, 'usage');
  assert.equal(usage.model, 'gpt-5');
  assert.equal(usage.tier, 'standard');

  // Insights view: provider maps to insightProvider, model to insightModel, plus kind.
  const insightsHash = buildAnalyticsRouteHash({
    ...analyticsFallback, view: 'insights', insightProvider: 'anthropic', insightModel: 'claude', kind: 'weekly', model: 'ignored',
  });
  assert.equal(insightsHash, 'analytics?view=insights&from=2026-01-01&to=2026-01-30&provider=anthropic&model=claude&kind=weekly');
  const insights = parseAnalyticsRouteHash(`#${insightsHash}`, analyticsFallback);
  assert.equal(insights.view, 'insights');
  assert.equal(insights.insightProvider, 'anthropic');
  assert.equal(insights.insightModel, 'claude');
  assert.equal(insights.kind, 'weekly');
  assert.equal(insights.model, ''); // usage-model not set on insights view

  // Skills view: shared filters survive, unrelated specialized state does not.
  const skillsHash = buildAnalyticsRouteHash({
    ...analyticsFallback,
    view: 'skills',
    project: 'agentmonitor',
    agent: 'codex',
    skillHarness: 'codex',
    skillQuery: 'test strategy',
    skillSignal: 'rehydrated',
    skillSort: 'name',
    model: 'ignored',
    traceId: 'ignored',
  });
  assert.equal(
    skillsHash,
    'analytics?view=skills&from=2026-01-01&to=2026-01-30&project=agentmonitor&agent=codex&harness=codex&skill=test+strategy&signal=rehydrated&sort=name',
  );
  const skills = parseAnalyticsRouteHash(`#${skillsHash}`, analyticsFallback);
  assert.equal(skills.view, 'skills');
  assert.equal(skills.project, 'agentmonitor');
  assert.equal(skills.agent, 'codex');
  assert.equal(skills.skillHarness, 'codex');
  assert.equal(skills.skillQuery, 'test strategy');
  assert.equal(skills.skillSignal, 'rehydrated');
  assert.equal(skills.skillSort, 'name');
  assert.equal(skills.model, '');
  assert.equal(skills.traceId, null);
});

test('search hashes omit default sort and fall back on non-search hashes', () => {
  const fallback = {
    query: '',
    project: '',
    agent: '',
    sort: 'recent' as const,
  };

  assert.equal(buildSearchHash({ ...fallback, query: 'hello' }), 'search?q=hello');
  assert.deepEqual(parseSearchHash('#sessions?session=abc', fallback), fallback);
});

test('parseAppHash accepts a hash with or without the leading #, and unknown tabs fall back to monitor', () => {
  assert.equal(parseAppHash('search?q=x').tab, 'search');
  assert.equal(parseAppHash('#search').params.toString(), '');
  assert.equal(parseAppHash('#nonsense?q=x').tab, 'monitor');
});

test('buildAppHash skips empty values but keeps a numeric zero, and passes URLSearchParams through', () => {
  assert.equal(buildAppHash('sessions', { project: '', agent: null, session: undefined, message: 0 }), 'sessions?message=0');
  assert.equal(buildAppHash('search', {}), 'search');
  assert.equal(buildAppHash('search', new URLSearchParams('q=a&sort=relevance')), 'search?q=a&sort=relevance');
});

test('message ordinal 0 survives a sessions round-trip', () => {
  const state = { view: 'browse' as const, project: '', agent: '', sessionId: 's1', messageOrdinal: 0 };
  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?session=s1&message=0');
  assert.deepEqual(
    parseSessionsHash(`#${hash}`, { view: 'browse', project: '', agent: '', sessionId: null, messageOrdinal: null }),
    state,
  );
});

test('search hashes round-trip reserved characters in the query', () => {
  // The parser splits the hash on "?", so a literal "?" or "#" in a query must
  // be encoded by the builder or the query is truncated.
  const state = { query: 'why? a&b=c #1 100%', project: 'p q', agent: '', sort: 'recent' as const };
  const hash = buildSearchHash(state);
  assert.deepEqual(parseSearchHash(`#${hash}`, { query: '', project: '', agent: '', sort: 'recent' }), state);
});

test('parseSearchHash ignores an unknown sort value', () => {
  const fallback = { query: '', project: '', agent: '', sort: 'recent' as const };
  assert.equal(parseSearchHash('#search?q=x&sort=bogus', fallback).sort, 'recent');
});

test('search sort: an omitted sort param means "recent" even when the fallback differs', {
  todo: 'latent: buildSearchHash omits sort only for "recent", but parseSearchHash fills a missing sort from fallback.sort. Harmless while the only URL-synced store defaults to "recent".',
}, () => {
  const relevanceDefault = { query: '', project: '', agent: '', sort: 'relevance' as const };
  const hash = buildSearchHash({ query: 'x', project: '', agent: '', sort: 'recent' });
  assert.equal(parseSearchHash(`#${hash}`, relevanceDefault).sort, 'recent');
});

test('parseAnalyticsRouteHash coerces unknown view/signal/sort values to their defaults', () => {
  const parsed = parseAnalyticsRouteHash('#analytics?view=bogus&signal=nope&sort=nope', analyticsFallback);
  assert.equal(parsed.view, 'overview');
  const skills = parseAnalyticsRouteHash('#analytics?view=skills&signal=nope&sort=nope', analyticsFallback);
  assert.equal(skills.skillSignal, 'all');
  assert.equal(skills.skillSort, 'volume');
});

test('parseAnalyticsRouteHash falls back for missing dates and non-analytics hashes', () => {
  const parsed = parseAnalyticsRouteHash('#analytics?project=am', analyticsFallback);
  assert.equal(parsed.from, analyticsFallback.from);
  assert.equal(parsed.to, analyticsFallback.to);
  assert.equal(parseAnalyticsRouteHash('#sessions?project=am', analyticsFallback), analyticsFallback);
});

test('buildAnalyticsRouteHash omits the default skill signal and sort', () => {
  assert.equal(
    buildAnalyticsRouteHash({ ...analyticsFallback, view: 'skills', skillSignal: 'all', skillSort: 'volume' }),
    'analytics?view=skills&from=2026-01-01&to=2026-01-30',
  );
});

test('quality view carries session and trace; other views drop them', () => {
  const qualityHash = buildAnalyticsRouteHash({ ...analyticsFallback, view: 'quality', sessionId: 's1', traceId: 't1' });
  assert.equal(qualityHash, 'analytics?view=quality&from=2026-01-01&to=2026-01-30&session=s1&trace=t1');
  const quality = parseAnalyticsRouteHash(`#${qualityHash}`, analyticsFallback);
  assert.equal(quality.sessionId, 's1');
  assert.equal(quality.traceId, 't1');

  const usage = parseAnalyticsRouteHash('#analytics?view=usage&session=s1&trace=t1', analyticsFallback);
  assert.equal(usage.sessionId, null);
  assert.equal(usage.traceId, null);
});

test('insight provider and kind persist from the current state when another view is active', () => {
  const current = { ...analyticsFallback, insightProvider: 'anthropic', kind: 'weekly' };
  const usage = parseAnalyticsRouteHash('#analytics?view=usage&provider=openai', current);
  assert.equal(usage.insightProvider, 'anthropic'); // usage's provider param is the billed provider
  assert.equal(usage.provider, 'openai');
  assert.equal(usage.kind, 'weekly');
});

test('buildAnalyticsQualityHash always targets the quality view and adds only the given scope', () => {
  assert.equal(buildAnalyticsQualityHash(), 'analytics?view=quality');
  assert.equal(buildAnalyticsQualityHash({ sessionId: 's1' }), 'analytics?view=quality&session=s1');
  assert.equal(buildAnalyticsQualityHash({ traceId: 't1' }), 'analytics?view=quality&trace=t1');
  assert.equal(buildAnalyticsQualityHash({ sessionId: 's1', traceId: 't1' }), 'analytics?view=quality&session=s1&trace=t1');
});
