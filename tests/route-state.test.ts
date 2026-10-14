import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalyticsQualityHash,
  buildAnalyticsRouteHash,
  buildAppHash,
  buildSessionsHash,
  canonicalizeLegacyAnalyticsHash,
  canonicalizeLegacyPinnedHash,
  canonicalizeLegacySearchHash,
  defaultSessionsRouteState,
  parseAnalyticsRouteHash,
  parseAppHash,
  parseSessionsHash,
  type AnalyticsRouteState,
  type SessionsRouteState,
} from '../frontend/src/lib/route-state.ts';

const sessionsFallback: SessionsRouteState = defaultSessionsRouteState();

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
  assert.equal(buildAppHash('sessions', { q: 'quota reset', project: 'agentmonitor' }), 'sessions?q=quota+reset&project=agentmonitor');
});

test('benchmarks is a routable tab that carries a selected study', () => {
  assert.equal(parseAppHash('#benchmarks').tab, 'benchmarks');
  assert.equal(buildAppHash('benchmarks', { study: 'sha-abc' }), 'benchmarks?study=sha-abc');
  const parsed = parseAppHash('#benchmarks?study=sha-abc');
  assert.equal(parsed.tab, 'benchmarks');
  assert.equal(parsed.params.get('study'), 'sha-abc');
});

test('sessions hashes round-trip selected session and filters', () => {
  const state: SessionsRouteState = {
    ...sessionsFallback,
    project: 'agentmonitor',
    agent: 'codex',
    sessionId: 'session-123',
    messageOrdinal: 17,
  };

  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?project=agentmonitor&agent=codex&session=session-123&message=17');
  assert.deepEqual(parseSessionsHash(`#${hash}`, sessionsFallback), state);
});

test('parseSessionsHash ignores invalid message ordinals and non-session hashes', () => {
  const fallback = { ...sessionsFallback, project: 'fallback' };

  assert.deepEqual(parseSessionsHash('#analytics?project=x', fallback), fallback);
  assert.deepEqual(parseSessionsHash('#sessions?session=abc&message=nope', fallback), {
    ...sessionsFallback,
    sessionId: 'abc',
    messageOrdinal: null,
  });
});

test('a sessions search rides the hash: query, filters, and non-default sort', () => {
  const state: SessionsRouteState = {
    ...sessionsFallback,
    query: 'token usage',
    project: 'agentmonitor',
    agent: 'claude_code',
    sort: 'relevance',
  };

  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?q=token+usage&project=agentmonitor&agent=claude_code&sort=relevance');
  assert.deepEqual(parseSessionsHash(`#${hash}`, sessionsFallback), state);
  assert.equal(buildSessionsHash({ ...sessionsFallback, query: 'hello' }), 'sessions?q=hello');
});

test('an open search result keeps the search in the hash so closing the viewer returns to it', () => {
  const state: SessionsRouteState = {
    ...sessionsFallback,
    query: 'quota',
    sort: 'relevance',
    sessionId: 's1',
    messageOrdinal: 4,
  };
  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?q=quota&sort=relevance&session=s1&message=4');
  assert.deepEqual(parseSessionsHash(`#${hash}`, sessionsFallback), state);
});

test('sort only serializes while it orders full-text results', () => {
  // No query: nothing is sorted by match, so the sort stays out of the link.
  assert.equal(buildSessionsHash({ ...sessionsFallback, sort: 'relevance' }), 'sessions');
  // Pinned messages keep their own order, even with a query narrowing them.
  assert.equal(
    buildSessionsHash({ ...sessionsFallback, query: 'x', sort: 'relevance', pinned: true }),
    'sessions?q=x&pinned=1',
  );
});

test('parseSessionsHash reads an omitted or unknown sort as recent, whatever the fallback', () => {
  const relevanceFallback = { ...sessionsFallback, sort: 'relevance' as const };
  assert.equal(parseSessionsHash('#sessions?q=x', relevanceFallback).sort, 'recent');
  assert.equal(parseSessionsHash('#sessions?q=x&sort=bogus', relevanceFallback).sort, 'recent');
});

test('sessions hashes round-trip reserved characters in the query', () => {
  // The parser splits the hash on "?", so a literal "?" or "#" in a query must
  // be encoded by the builder or the query is truncated.
  const state: SessionsRouteState = { ...sessionsFallback, query: 'why? a&b=c #1 100%', project: 'p q' };
  assert.deepEqual(parseSessionsHash(`#${buildSessionsHash(state)}`, sessionsFallback), state);
});

test('Pinned is a filter on the sessions list, kept beside the other filters', () => {
  const state: SessionsRouteState = { ...sessionsFallback, pinned: true, project: 'agentmonitor', agent: 'codex' };
  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?project=agentmonitor&agent=codex&pinned=1');
  assert.deepEqual(parseSessionsHash(`#${hash}`, sessionsFallback), state);
  assert.equal(parseSessionsHash('#sessions?pinned=0', sessionsFallback).pinned, false);
  assert.equal(parseSessionsHash('#sessions', { ...sessionsFallback, pinned: true }).pinned, false);
});

test('legacy Pinned links redirect to the Pinned filter', () => {
  // Neither a standalone tab nor a sub-view any more.
  assert.equal(parseAppHash('#pinned').tab, 'monitor');
  assert.equal(canonicalizeLegacyPinnedHash('#pinned'), 'sessions?pinned=1');
  assert.equal(canonicalizeLegacyPinnedHash('#sessions?view=pinned'), 'sessions?pinned=1');
  assert.equal(canonicalizeLegacyPinnedHash('sessions?view=pinned&project=am'), 'sessions?project=am&pinned=1');
  // Canonical or unrelated hashes are left alone.
  assert.equal(canonicalizeLegacyPinnedHash('#sessions?pinned=1'), null);
  assert.equal(canonicalizeLegacyPinnedHash('#sessions?session=abc'), null);
  assert.equal(canonicalizeLegacyPinnedHash('#analytics?view=usage'), null);
  assert.equal(canonicalizeLegacyPinnedHash(''), null);
});

test('legacy Search links redirect into the Sessions search', () => {
  assert.equal(parseAppHash('#search?q=x').tab, 'monitor');
  assert.equal(canonicalizeLegacySearchHash('#search'), 'sessions');
  assert.equal(
    canonicalizeLegacySearchHash('#search?q=quota%20reset&project=am&agent=codex&sort=relevance'),
    'sessions?q=quota+reset&project=am&agent=codex&sort=relevance',
  );
  // A sort without a query has nothing to order.
  assert.equal(canonicalizeLegacySearchHash('search?project=am&sort=relevance'), 'sessions?project=am');
  // Canonical or unrelated hashes are left alone.
  assert.equal(canonicalizeLegacySearchHash('#sessions?q=x'), null);
  assert.equal(canonicalizeLegacySearchHash('#searchx'), null);
  assert.equal(canonicalizeLegacySearchHash(''), null);
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

test('parseAppHash accepts a hash with or without the leading #, and unknown tabs fall back to monitor', () => {
  assert.equal(parseAppHash('sessions?q=x').tab, 'sessions');
  assert.equal(parseAppHash('#sessions').params.toString(), '');
  assert.equal(parseAppHash('#nonsense?q=x').tab, 'monitor');
});

test('buildAppHash skips empty values but keeps a numeric zero, and passes URLSearchParams through', () => {
  assert.equal(buildAppHash('sessions', { project: '', agent: null, session: undefined, message: 0 }), 'sessions?message=0');
  assert.equal(buildAppHash('sessions', {}), 'sessions');
  assert.equal(buildAppHash('sessions', new URLSearchParams('q=a&sort=relevance')), 'sessions?q=a&sort=relevance');
});

test('message ordinal 0 survives a sessions round-trip', () => {
  const state: SessionsRouteState = { ...sessionsFallback, sessionId: 's1', messageOrdinal: 0 };
  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?session=s1&message=0');
  assert.deepEqual(parseSessionsHash(`#${hash}`, sessionsFallback), state);
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
