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
