import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type {
  getMonitorSessionWithEvents as getMonitorSessionWithEventsType,
  getUsageSummary as getUsageSummaryType,
  listMonitorSessions as listMonitorSessionsType,
} from '../src/db/v2-queries.js';

// Codex reports each response's usage twice: live over OTEL, then again when the
// rollout JSONL is imported. The Monitor's session totals (the Active Agents
// cards and the session detail) must reconcile that overlap the way Usage does,
// or a card shows roughly twice the cost the header's "Cost today" counts.

let tempDir = '';
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
let listMonitorSessions: typeof listMonitorSessionsType;
let getMonitorSessionWithEvents: typeof getMonitorSessionWithEventsType;
let getUsageSummary: typeof getUsageSummaryType;
let day = '';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-monitor-session-usage-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_SESSION_TIMEOUT = '1000000';

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const queries = await import('../src/db/v2-queries.js');
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  listMonitorSessions = queries.listMonitorSessions;
  getMonitorSessionWithEvents = queries.getMonitorSessionWithEvents;
  getUsageSummary = queries.getUsageSummary;
  initSchema();

  const db = getDb();
  day = new Date().toISOString().slice(0, 10);
  db.exec(`
    INSERT INTO agents (id, agent_type, name) VALUES
      ('codex-default', 'codex', 'Codex'),
      ('claude-default', 'claude_code', 'Claude')
  `);
  const session = db.prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, status, started_at, last_event_at)
    VALUES (?, ?, ?, 'alpha', 'active', ?, ?)
  `);
  session.run('codex-live', 'codex-default', 'codex', `${day} 12:00:00`, `${day} 12:30:00`);
  session.run('claude-live', 'claude-default', 'claude_code', `${day} 12:00:00`, `${day} 12:30:00`);

  const event = db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, source, created_at, model,
      tokens_in, tokens_out, cost_usd, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
  `);
  // Two responses, each seen by OTEL and then by the import.
  event.run('otel-1', 'codex-live', 'codex', 'llm_response', 'otel', `${day} 12:01:00`, 'gpt-5.5', 1000, 100, 1.0);
  event.run('import-1', 'codex-live', 'codex', 'llm_response', 'import', `${day} 12:01:00`, 'gpt-5.5', 900, 90, 0.9);
  event.run('otel-2', 'codex-live', 'codex', 'llm_response', 'otel', `${day} 12:10:00`, 'gpt-5.5', 2000, 200, 2.0);
  event.run('import-2', 'codex-live', 'codex', 'llm_response', 'import', `${day} 12:10:00`, 'gpt-5.5', 1800, 180, 1.8);
  // A response the import has not reached yet: OTEL is the only record, so it counts.
  event.run('otel-3', 'codex-live', 'codex', 'llm_response', 'otel', `${day} 12:20:00`, 'gpt-5.5', 500, 50, 0.5);
  // A usage-free event still counts as an event.
  event.run('tool-1', 'codex-live', 'codex', 'tool_use', 'otel', `${day} 12:05:00`, null, null, null, null);

  // Claude Code OTEL and import rows are not the Codex overlap and both stay.
  event.run('claude-otel', 'claude-live', 'claude_code', 'llm_response', 'otel', `${day} 12:01:00`, 'claude-sonnet-4-5', 100, 10, 0.1);
  event.run('claude-import', 'claude-live', 'claude_code', 'llm_response', 'import', `${day} 12:02:00`, 'claude-sonnet-4-5', 200, 20, 0.2);
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const EXPECTED_CODEX = { event_count: 6, tokens_in: 3200, tokens_out: 320, total_cost_usd: 3.2 };

function totals(row: { event_count: number; tokens_in: number; tokens_out: number; total_cost_usd: number }) {
  return {
    event_count: row.event_count,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    total_cost_usd: Math.round(row.total_cost_usd * 1e6) / 1e6,
  };
}

test('the Active Agents session list counts overlapping Codex OTEL usage once', () => {
  const { sessions } = listMonitorSessions({ exclude_status: 'ended', limit: 0 });
  const codex = sessions.find(row => row.id === 'codex-live');
  assert.ok(codex);
  assert.deepEqual(totals(codex), EXPECTED_CODEX);
});

test('the session detail counts overlapping Codex OTEL usage once', () => {
  const { session, events } = getMonitorSessionWithEvents('codex-live', 50);
  assert.ok(session);
  assert.deepEqual(totals(session), EXPECTED_CODEX);
  assert.equal(events.length, 6, 'the raw event stream keeps both sources');
});

test('the session total matches the reconciled Usage cost', () => {
  const usage = getUsageSummary({ date_from: day, date_to: day, agent: 'codex' });
  assert.equal(usage.total_cost_usd, EXPECTED_CODEX.total_cost_usd);
});

test('Claude Code sessions keep both OTEL and imported usage', () => {
  const { sessions } = listMonitorSessions({ exclude_status: 'ended', limit: 0 });
  const claude = sessions.find(row => row.id === 'claude-live');
  assert.ok(claude);
  assert.equal(claude.tokens_in, 300);
  const { session } = getMonitorSessionWithEvents('claude-live');
  assert.ok(session);
  assert.equal(session.tokens_in, 300);
});
