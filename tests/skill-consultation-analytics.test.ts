import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { getDb as getDbType, closeDb as closeDbType } from '../src/db/connection.js';
import type { getAnalyticsSkillConsultations as getAnalyticsSkillConsultationsType } from '../src/db/v2-queries.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-consultations-'));
process.env['AGENTMONITOR_DB_PATH'] = path.join(tempDir, 'test.db');
process.env['AGENTMONITOR_SKILL_DIRS'] = path.join(tempDir, 'skills');

let getDb: typeof getDbType;
let closeDb: typeof closeDbType;
let getAnalyticsSkillConsultations: typeof getAnalyticsSkillConsultationsType;

before(async () => {
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  const { initSchema } = await import('../src/db/schema.js');
  const { insertParsedSession, parseSessionMessages } = await import('../src/parser/claude-code.js');
  ({ getAnalyticsSkillConsultations } = await import('../src/db/v2-queries.js'));
  initSchema();
  getDb().prepare(`
    INSERT INTO skill_catalog_snapshots (name, version, first_seen_at, last_seen_at)
    VALUES ('test-strategy', '2.0.0', '2026-06-01T00:00:00Z', '2026-08-01T00:00:00Z')
  `).run();

  const line = (timestamp: string, id: string, cwd = '/work/alpha') => JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'test-strategy' } }],
    },
  });
  const full = parseSessionMessages([
    line('2026-07-10T10:00:00Z', 'one'),
    line('2026-07-10T10:01:00Z', 'two'),
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      cwd: '/work/alpha',
      timestamp: '2026-07-10T10:02:00Z',
    }),
    line('2026-07-10T10:03:00Z', 'three', '/work/beta'),
  ].join('\n'), 'eligible-session');
  insertParsedSession(getDb(), full, '/tmp/full.jsonl', 10, 'full');

  const degraded = parseSessionMessages([
    '{"broken":',
    line('2026-07-10T11:00:00Z', 'degraded'),
  ].join('\n'), 'degraded-session');
  insertParsedSession(getDb(), degraded, '/tmp/degraded.jsonl', 10, 'degraded');
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('classifies consultations and reconciles coverage, projects, and versions', () => {
  const result = getAnalyticsSkillConsultations({
    agent: 'claude',
    date_from: '2026-07-10',
    date_to: '2026-07-10',
  });
  const harness = result.byHarness.find(item => item.harness === 'claude');
  const row = harness?.skills.find(skill => skill.name === 'test-strategy');
  assert.ok(row);
  assert.deepEqual(row.classes, {
    first_read: 1,
    rehydration_after_compaction: 1,
    repeat_no_compaction: 1,
    unclassifiable: 1,
  });
  assert.equal(row.invocations, 4);
  assert.equal(row.sessionsInWindow, 2);
  assert.equal(row.eligibleSessionsInWindow, 1);
  assert.equal(row.sessionsWithFirstRead, 1);
  assert.equal(row.firstReadEngagementRate, 1);
  assert.equal(
    row.ineligibleSessionsByReason.find(reason => reason.reason === 'malformed_source_record')?.sessions,
    1,
  );
  assert.equal(
    row.projectBreadth.sessions.reduce((sum, project) => sum + project.sessions, 0),
    row.sessionsWithFirstRead,
  );
  assert.equal(row.versions[0]?.version, '2.0.0');
  assert.equal(row.versions[0]?.invocations, row.invocations);
  assert.equal(
    Object.values(row.classes).reduce((sum, count) => sum + count, 0),
    row.invocations,
  );
  assert.equal(result.comparability.status, 'single_harness');
  assert.equal(result.windowSemantics.toExclusive, '2026-07-11T00:00:00.000Z');
});
