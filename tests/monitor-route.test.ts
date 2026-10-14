import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMonitorHash,
  canonicalizeLegacyLiveHash,
  parseAppHash,
  parseMonitorSessionId,
} from '../frontend/src/lib/route-state.ts';

test('Live is no longer a tab: #live parses as Monitor and is rewritten to it', () => {
  assert.equal(parseAppHash('#live').tab, 'monitor');
  assert.equal(canonicalizeLegacyLiveHash('#live'), '');
  assert.equal(canonicalizeLegacyLiveHash('live?status=ended'), '');
  assert.equal(canonicalizeLegacyLiveHash('#monitor'), null);
  assert.equal(canonicalizeLegacyLiveHash('#livestream'), null);
  assert.equal(canonicalizeLegacyLiveHash(''), null);
});

test('a Monitor drill-in carries the followed session in the hash', () => {
  assert.equal(buildMonitorHash(null), '');
  assert.equal(buildMonitorHash('abc-123'), 'monitor?session=abc-123');

  const hash = buildMonitorHash('rollout-2026/a b&c');
  assert.equal(parseAppHash(hash).tab, 'monitor');
  assert.equal(parseMonitorSessionId(hash), 'rollout-2026/a b&c');
  assert.equal(parseMonitorSessionId(`#${hash}`), 'rollout-2026/a b&c');
});

test('only a Monitor hash yields a followed session', () => {
  assert.equal(parseMonitorSessionId(''), null);
  assert.equal(parseMonitorSessionId('#monitor'), null);
  assert.equal(parseMonitorSessionId('#monitor?session='), null);
  assert.equal(parseMonitorSessionId('#sessions?session=abc'), null);
});
