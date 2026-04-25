import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppHash,
  buildSearchHash,
  buildSessionsHash,
  parseAppHash,
  parseSearchHash,
  parseSessionsHash,
} from '../frontend/src/lib/route-state.ts';

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
    project: 'agentmonitor',
    agent: 'codex',
    sessionId: 'session-123',
    messageOrdinal: 17,
  };

  const hash = buildSessionsHash(state);
  assert.equal(hash, 'sessions?project=agentmonitor&agent=codex&session=session-123&message=17');
  assert.deepEqual(parseSessionsHash(`#${hash}`, {
    project: '',
    agent: '',
    sessionId: null,
    messageOrdinal: null,
  }), state);
});

test('parseSessionsHash ignores invalid message ordinals and non-session hashes', () => {
  const fallback = {
    project: 'fallback',
    agent: '',
    sessionId: null,
    messageOrdinal: null,
  };

  assert.deepEqual(parseSessionsHash('#search?q=test', fallback), fallback);
  assert.deepEqual(parseSessionsHash('#sessions?session=abc&message=nope', fallback), {
    project: '',
    agent: '',
    sessionId: 'abc',
    messageOrdinal: null,
  });
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
