import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
  insightProvider: 'openai',
  insightModel: '',
  kind: '',
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
