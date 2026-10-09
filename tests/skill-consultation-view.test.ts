import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SkillConsultationAnalytics,
  SkillConsultationRow,
} from '../frontend/src/lib/api/client.js';
import {
  countSkillRows,
  filterSkillConsultations,
  selectSkillConsultationPreview,
} from '../frontend/src/lib/skill-consultation-view.js';

function skill(
  name: string,
  harness: string,
  options: {
    invocations?: number;
    firstReads?: number;
    eligible?: number;
    rehydrations?: number;
    presentedUnread?: number;
    unclassified?: number;
  } = {},
): SkillConsultationRow {
  const eligible = options.eligible ?? 1;
  const firstReads = options.firstReads ?? 0;
  return {
    name,
    harness,
    invocations: options.invocations ?? 1,
    classes: {
      first_read: firstReads,
      rehydration_after_compaction: options.rehydrations ?? 0,
      repeat_no_compaction: 0,
      unclassifiable: options.unclassified ?? 0,
    },
    sessionsInWindow: eligible,
    eligibleSessionsInWindow: eligible,
    sessionsWithFirstRead: firstReads,
    firstReadEngagementRate: eligible > 0 ? firstReads / eligible : null,
    ineligibleSessionsByReason: [],
    projectBreadth: {
      distinctObservedProjects: 0,
      sessions: [],
    },
    versions: [],
    exposure: {
      jointlyEligiblePresentedSessions: options.presentedUnread ?? 0,
      presentedWithFirstRead: 0,
      presentedWithoutFirstRead: options.presentedUnread ?? 0,
    },
  };
}

function harness(
  id: string,
  skills: SkillConsultationRow[],
): SkillConsultationAnalytics['byHarness'][number] {
  return {
    harness: id,
    detectionSemantics: id === 'claude' ? 'explicit_skill_tool' : 'concrete_skill_path',
    skills,
  };
}

test('overview preview stays bounded while representing every selected harness', () => {
  const preview = selectSkillConsultationPreview([
    harness('claude', [
      skill('claude-1', 'claude', { invocations: 9 }),
      skill('claude-2', 'claude', { invocations: 8 }),
      skill('claude-3', 'claude', { invocations: 7 }),
      skill('claude-4', 'claude', { invocations: 6 }),
      skill('claude-5', 'claude', { invocations: 5 }),
      skill('claude-6', 'claude', { invocations: 4 }),
    ]),
    harness('codex', [
      skill('codex-1', 'codex', { invocations: 3 }),
      skill('codex-2', 'codex', { invocations: 2 }),
    ]),
  ], 6);

  assert.equal(countSkillRows(preview), 6);
  assert.deepEqual(
    preview.map(item => [item.harness, item.skills.map(row => row.name)]),
    [
      ['claude', ['claude-1', 'claude-2', 'claude-3', 'claude-4']],
      ['codex', ['codex-1', 'codex-2']],
    ],
  );
});

test('explorer filters observed signals without pooling harness lanes', () => {
  const filtered = filterSkillConsultations([
    harness('claude', [
      skill('first-read-skill', 'claude', { firstReads: 1 }),
      skill('rehydrated-skill', 'claude', { rehydrations: 2 }),
    ]),
    harness('codex', [
      skill('presented-skill', 'codex', { presentedUnread: 1 }),
      skill('unknown-skill', 'codex', { unclassified: 1 }),
    ]),
  ], {
    harness: 'codex',
    query: 'skill',
    signal: 'presented_unread',
    sort: 'volume',
  });

  assert.deepEqual(
    filtered.map(item => [item.harness, item.skills.map(row => row.name)]),
    [['codex', ['presented-skill']]],
  );
});

test('explorer sort orders null engagement last and uses volume as a stable tie-breaker', () => {
  const filtered = filterSkillConsultations([
    harness('codex', [
      skill('none', 'codex', { eligible: 0, invocations: 20 }),
      skill('lower', 'codex', { eligible: 4, firstReads: 1, invocations: 10 }),
      skill('higher-low-volume', 'codex', { eligible: 2, firstReads: 1, invocations: 2 }),
      skill('higher-high-volume', 'codex', { eligible: 2, firstReads: 1, invocations: 4 }),
    ]),
  ], {
    harness: '',
    query: '',
    signal: 'all',
    sort: 'first_read_rate',
  });

  assert.deepEqual(
    filtered[0]?.skills.map(row => row.name),
    ['higher-high-volume', 'higher-low-volume', 'lower', 'none'],
  );
});

const ALL_FILTERS = { harness: '', query: '', signal: 'all', sort: 'volume' } as const;
const names = (harnesses: ReturnType<typeof filterSkillConsultations>) =>
  harnesses.map(item => [item.harness, item.skills.map(row => row.name)]);

test('overview preview ranks unsorted input by volume, breaking ties by name', () => {
  const input = [
    harness('claude', [
      skill('zeta', 'claude', { invocations: 5 }),
      skill('low', 'claude', { invocations: 1 }),
      skill('alpha', 'claude', { invocations: 5 }),
      skill('top', 'claude', { invocations: 9 }),
    ]),
  ];
  const preview = selectSkillConsultationPreview(input, 3);
  assert.deepEqual(names(preview), [['claude', ['top', 'alpha', 'zeta']]]);
  // The caller's rows keep their original order.
  assert.deepEqual(input[0].skills.map(row => row.name), ['zeta', 'low', 'alpha', 'top']);
});

test('overview preview takes rank-by-rank across harnesses and drops empty lanes', () => {
  const preview = selectSkillConsultationPreview([
    harness('claude', [skill('c1', 'claude', { invocations: 9 }), skill('c2', 'claude', { invocations: 8 })]),
    harness('empty', []),
    harness('codex', [skill('x1', 'codex', { invocations: 1 }), skill('x2', 'codex', { invocations: 1 })]),
    harness('antigravity', [skill('a1', 'antigravity', { invocations: 2 })]),
  ], 4);
  // Rank 0 from every lane first (3 rows), then rank 1 from the first lane.
  assert.deepEqual(names(preview), [
    ['claude', ['c1', 'c2']],
    ['codex', ['x1']],
    ['antigravity', ['a1']],
  ]);
});

test('overview preview returns everything under the limit and nothing for a non-positive limit', () => {
  const input = [
    harness('claude', [skill('c1', 'claude')]),
    harness('codex', [skill('x1', 'codex')]),
  ];
  assert.equal(countSkillRows(selectSkillConsultationPreview(input, 10)), 2);
  assert.deepEqual(selectSkillConsultationPreview(input, 0), []);
  assert.deepEqual(selectSkillConsultationPreview(input, -1), []);
  assert.deepEqual(selectSkillConsultationPreview([], 6), []);
});

test('explorer query is trimmed and case-insensitive; an empty harness filter keeps every lane', () => {
  const filtered = filterSkillConsultations([
    harness('claude', [skill('Test-Strategy', 'claude'), skill('write-plan', 'claude')]),
    harness('codex', [skill('test-runner', 'codex')]),
  ], { ...ALL_FILTERS, query: '  TEST ' });
  assert.deepEqual(names(filtered), [['claude', ['Test-Strategy']], ['codex', ['test-runner']]]);
});

test('each explorer signal selects only rows with that observed evidence', () => {
  const rows = [
    harness('claude', [
      skill('first', 'claude', { firstReads: 1, invocations: 5 }),
      skill('rehydrated', 'claude', { rehydrations: 1, invocations: 4 }),
      skill('presented', 'claude', { presentedUnread: 1, invocations: 3 }),
      skill('unclassified', 'claude', { unclassified: 1, invocations: 2 }),
      skill('quiet', 'claude', { invocations: 1 }),
    ]),
  ];
  const bySignal = (signal: 'all' | 'first_read' | 'rehydrated' | 'presented_unread' | 'unclassified') =>
    filterSkillConsultations(rows, { ...ALL_FILTERS, signal })[0]?.skills.map(row => row.name) ?? [];
  assert.deepEqual(bySignal('first_read'), ['first']);
  assert.deepEqual(bySignal('rehydrated'), ['rehydrated']);
  assert.deepEqual(bySignal('presented_unread'), ['presented']);
  assert.deepEqual(bySignal('unclassified'), ['unclassified']);
  assert.deepEqual(bySignal('all'), ['first', 'rehydrated', 'presented', 'unclassified', 'quiet']);
});

test('a lane with no rows left after filtering is dropped, not rendered empty', () => {
  const filtered = filterSkillConsultations([
    harness('claude', [skill('quiet', 'claude')]),
    harness('codex', [skill('first', 'codex', { firstReads: 1 })]),
  ], { ...ALL_FILTERS, signal: 'first_read' });
  assert.deepEqual(names(filtered), [['codex', ['first']]]);
});

test('explorer sorts by rehydrations with volume as tie-breaker, and by name ascending', () => {
  const rows = [
    harness('codex', [
      skill('b-low', 'codex', { rehydrations: 1, invocations: 1 }),
      skill('a-most', 'codex', { rehydrations: 3, invocations: 1 }),
      skill('c-busy', 'codex', { rehydrations: 1, invocations: 7 }),
    ]),
  ];
  assert.deepEqual(
    filterSkillConsultations(rows, { ...ALL_FILTERS, sort: 'rehydrations' })[0]?.skills.map(row => row.name),
    ['a-most', 'c-busy', 'b-low'],
  );
  assert.deepEqual(
    filterSkillConsultations(rows, { ...ALL_FILTERS, sort: 'name' })[0]?.skills.map(row => row.name),
    ['a-most', 'b-low', 'c-busy'],
  );
});

test('engagement-rate sort keeps every null rate last regardless of input position', () => {
  const filtered = filterSkillConsultations([
    harness('codex', [
      skill('null-busy', 'codex', { eligible: 0, invocations: 50 }),
      skill('half', 'codex', { eligible: 2, firstReads: 1 }),
      skill('null-quiet', 'codex', { eligible: 0, invocations: 1 }),
      skill('zero', 'codex', { eligible: 3, firstReads: 0 }),
      skill('full', 'codex', { eligible: 1, firstReads: 1 }),
    ]),
  ], { ...ALL_FILTERS, sort: 'first_read_rate' });
  // A 0% rate is a real measurement and ranks above "no eligible sessions".
  assert.deepEqual(filtered[0]?.skills.map(row => row.name), ['full', 'half', 'zero', 'null-busy', 'null-quiet']);
});
