import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

// Isolate the DB and pin the reporting zone before importing anything that
// reads config. Tokyo is deliberately neither UTC (the old reading) nor the
// America/New_York that daily activity used to hardcode, so every surface has
// to honor the configured zone to pass.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-local-days-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_TIMEZONE = 'Asia/Tokyo';

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const q = await import('../src/db/v2-queries.js');
const { listSessionTraces } = await import('../src/trace-quality/on-demand.js');
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');

// The local day under test is Thursday 2026-09-10 in Tokyo (UTC+9).
const EARLY = '2026-09-09T16:00:00.000Z'; // 01:00 JST Sep 10 — still Sep 9 in UTC
const LATE = '2026-09-10T14:30:00.000Z'; //  23:30 JST Sep 10
const NEXT = '2026-09-10T16:30:00.000Z'; //  01:30 JST Sep 11 — still Sep 10 in UTC
const DAY = { date_from: '2026-09-10', date_to: '2026-09-10' };
const TWO_DAYS = { date_from: '2026-09-10', date_to: '2026-09-11' };

// Weights make each row identifiable in any sum: the right Sep 10 answer is 11,
// the old UTC reading gives 110.
const ROWS = [
  { id: 'early', at: EARLY, weight: 1 },
  { id: 'late', at: LATE, weight: 10 },
  { id: 'next', at: NEXT, weight: 100 },
];

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  for (const row of ROWS) {
    insertEvent({
      session_id: `evt-${row.id}`, agent_type: 'claude_code', event_type: 'llm_response',
      status: 'success', tokens_in: row.weight, tokens_out: 0, model: 'claude-sonnet-5',
      client_timestamp: row.at, source: 'hook',
    });
    getDb().prepare(`
      INSERT INTO browsing_sessions (id, project, agent, started_at, ended_at, message_count, user_message_count)
      VALUES (?, 'local-days', 'claude', ?, ?, ?, 0)
    `).run(`bs-${row.id}`, row.at, row.at, row.weight);
    // A Codex read of a skill file is one skill invocation.
    insertEvent({
      session_id: `skill-${row.id}`, agent_type: 'codex', event_type: 'tool_use', tool_name: 'exec_command',
      status: 'success', client_timestamp: row.at, source: 'hook',
      metadata: { arguments: { cmd: 'cat /home/example/.codex/skills/test-strategy/SKILL.md' } },
    });
    maintainSessionTraceSummary(`evt-${row.id}`);
    // sessions.last_event_at is SQLite's zone-less UTC format.
    getDb().prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?')
      .run(row.at.replace('T', ' ').slice(0, 19), `evt-${row.id}`);
    getDb().prepare(`
      INSERT INTO execution_receipts (producer, execution_id, run_id, agent, role, started_at)
      VALUES ('test', ?, 'run', 'claude', 'worker', ?)
    `).run(`exec-${row.id}`, row.at);
  }
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('usage selects and buckets local days', () => {
  test('a one-day window holds that local day\'s rows', () => {
    assert.equal(q.getUsageSummary(DAY).total_input_tokens, 11);
  });

  test('daily buckets split at local midnight', () => {
    const daily = Object.fromEntries(q.getUsageDaily(TWO_DAYS).map(p => [p.date, p.input_tokens]));
    assert.deepEqual(daily, { '2026-09-10': 11, '2026-09-11': 100 });
  });

  test('a timestamp date_from starts the daily axis on its local day', () => {
    // The Monitor sends instants. EARLY is Sep 9 in UTC but Sep 10 in Tokyo, so
    // reading its UTC date would open the axis on an empty Sep 9.
    assert.deepEqual(q.getUsageDaily({ date_from: EARLY }).map(p => p.date), ['2026-09-10', '2026-09-11']);
  });

  test('active days count local days', () => {
    assert.equal(q.getUsageSummary(TWO_DAYS).active_days, 2);
    assert.equal(q.getUsageSummary(DAY).active_days, 1);
  });
});

describe('analytics selects and buckets local days', () => {
  const params = { ...TWO_DAYS, project: 'local-days' };

  test('activity buckets split at local midnight', () => {
    const activity = Object.fromEntries(q.getAnalyticsActivity(params).map(p => [p.date, p.messages]));
    assert.deepEqual(activity, { '2026-09-10': 11, '2026-09-11': 100 });
  });

  test('velocity counts local active days', () => {
    assert.equal(q.getAnalyticsVelocity(params).active_days, 2);
    assert.equal(q.getAnalyticsVelocity({ ...DAY, project: 'local-days' }).active_days, 1);
  });

  test('the heatmap plots only the selected local day, in local hours', () => {
    const plotted = q.getAnalyticsHourOfWeek({ ...DAY, project: 'local-days' })
      .filter(p => p.message_count > 0)
      .map(p => [p.day_of_week, p.hour_of_day, p.message_count]);
    // Thursday is 3 (Monday = 0).
    assert.deepEqual(plotted, [[3, 1, 1], [3, 23, 10]]);
  });
});

describe('session lists select local days', () => {
  test('the session browser', () => {
    const ids = q.listBrowsingSessions({ ...DAY, project: 'local-days' }).data.map(s => s.id).sort();
    assert.deepEqual(ids, ['bs-early', 'bs-late']);
  });

  test('the Monitor session list', () => {
    const ids = q.listMonitorSessions({ ...DAY, agent: 'claude_code' }).sessions.map(s => s.id).sort();
    assert.deepEqual(ids, ['evt-early', 'evt-late']);
  });

  test('observed executions', () => {
    const ids = q.listObservedExecutions(DAY).data.map((e: { execution_id: string }) => e.execution_id).sort();
    assert.deepEqual(ids, ['exec-early', 'exec-late']);
  });

  test('observed activity sessions', () => {
    const ids = q.listObservedSessions({ ...DAY, agent: 'claude' }).data
      .map((s: { session_id: string }) => s.session_id).filter(id => id.startsWith('evt-')).sort();
    assert.deepEqual(ids, ['evt-early', 'evt-late']);
  });
});

describe('daily conversation activity', () => {
  test('buckets in the configured zone and reports it', () => {
    const result = q.getDailyConversationActivity('2026-09-10', '2026-09-11');
    assert.equal(result.timezone, 'Asia/Tokyo');
    const byDay = new Map<string, number>();
    for (const row of result.data) {
      if (row.agent === 'claude') byDay.set(row.date, (byDay.get(row.date) ?? 0) + row.count);
    }
    assert.deepEqual(Object.fromEntries(byDay), { '2026-09-10': 2, '2026-09-11': 1 });
  });
});

describe('skills select and bucket local days', () => {
  test('daily skill counts split at local midnight', () => {
    const daily = Object.fromEntries(q.getAnalyticsSkillsDaily({ ...TWO_DAYS, agent: 'codex' }).map(d => [d.date, d.total]));
    assert.deepEqual(daily, { '2026-09-10': 2, '2026-09-11': 1 });
  });

  test('the consultation window is bounded by local midnights', () => {
    const { windowSemantics } = q.getAnalyticsSkillConsultations(DAY);
    assert.equal(windowSemantics.interval, 'local_day_half_open');
    assert.equal(windowSemantics.from, '2026-09-09T15:00:00.000Z');
    assert.equal(windowSemantics.toExclusive, '2026-09-10T15:00:00.000Z');
  });
});

describe('trace quality selects local days', () => {
  test('a one-day window lists that local day\'s traces', () => {
    const ids = listSessionTraces({ ...DAY, limit: 50 }).data.map(t => t.session_id).sort();
    assert.deepEqual(ids, ['evt-early', 'evt-late']);
  });
});
