import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

// Isolate the DB before importing anything that reads config.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-skill-overlap-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { selectSkillInvocationOccurrences } = await import('../src/skills/invocation-ledger.js');

// Codex writes the same run twice: OTEL carries the bare command, and the
// JSONL rollout (newer `exec`) wraps it in JS, so the strings differ.
const SESSION = '019a0000-0000-7000-8000-000000000001';
const JSONL_SESSION = `rollout-2026-07-01T09-00-00-${SESSION}`;
const read = (skill: string) => `cat ~/.agents/skills/${skill}/SKILL.md`;
const wrapped = (skill: string) => `const r = await tools.exec_command({cmd:"${read(skill)}"})`;

let ordinal = 0;

function otelRead(skill: string, at: string): void {
  getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, tool_name, status, created_at, client_timestamp, metadata, source)
    VALUES (?, 'codex', 'tool_use', 'exec_command', 'success', ?, ?, ?, 'otel')
  `).run(SESSION, at, at, JSON.stringify({ arguments: read(skill) }));
}

function jsonlRead(command: string, at: string): void {
  const message = getDb().prepare(
    `INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, 'assistant', '[]', ?)`,
  ).run(JSONL_SESSION, ordinal++, at);
  getDb().prepare(
    `INSERT INTO tool_calls (message_id, session_id, tool_name, input_json) VALUES (?, ?, 'exec', ?)`,
  ).run(message.lastInsertRowid, JSONL_SESSION, JSON.stringify({ cmd: command }));
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of selectSkillInvocationOccurrences(getDb())) out[o.skillName] = (out[o.skillName] ?? 0) + 1;
  return out;
}

describe('Codex OTEL and JSONL skill reads are reconciled per skill', () => {
  before(() => {
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  });
  beforeEach(() => {
    const db = getDb();
    assert.equal(fs.realpathSync(db.name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
    db.exec('DELETE FROM tool_calls; DELETE FROM messages; DELETE FROM browsing_sessions; DELETE FROM events;');
    db.prepare(
      `INSERT INTO browsing_sessions (id, agent, project, started_at, integration_mode) VALUES (?, 'codex', NULL, ?, 'codex-jsonl')`,
    ).run(JSONL_SESSION, '2026-07-01T09:00:00Z');
    ordinal = 0;
  });
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a skill seen only in JSONL still counts when OTEL saw a different one', () => {
    otelRead('skill-alpha', '2026-07-01T10:00:00Z');
    jsonlRead(read('skill-alpha'), '2026-07-01T10:00:00Z');
    jsonlRead(read('skill-beta'), '2026-07-01T10:05:00Z');
    assert.deepEqual(counts(), { 'skill-alpha': 1, 'skill-beta': 1 });
  });

  test('the same read reported by both sources counts once, even when the command text differs', () => {
    otelRead('skill-alpha', '2026-07-01T10:00:00Z');
    jsonlRead(wrapped('skill-alpha'), '2026-07-01T10:00:00Z');
    assert.deepEqual(counts(), { 'skill-alpha': 1 });
  });

  test('JSONL fills in reads OTEL missed for a skill it did see', () => {
    // OTEL export dropped out after the first read.
    otelRead('skill-alpha', '2026-07-01T10:00:00Z');
    jsonlRead(read('skill-alpha'), '2026-07-01T10:00:00Z');
    jsonlRead(read('skill-alpha'), '2026-07-01T11:00:00Z');
    assert.deepEqual(counts(), { 'skill-alpha': 2 });
  });

  test('the reads JSONL adds are the ones no OTEL row matches', () => {
    otelRead('skill-alpha', '2026-07-01T11:00:00Z');
    jsonlRead(wrapped('skill-alpha'), '2026-07-01T10:00:00Z');
    jsonlRead(read('skill-alpha'), '2026-07-01T11:00:00Z');
    const alpha = selectSkillInvocationOccurrences(getDb()).filter(o => o.skillName === 'skill-alpha');
    assert.deepEqual(alpha.map(o => [o.detectionSource, o.timestamp]).sort(), [
      ['codex_jsonl', '2026-07-01T10:00:00Z'],
      ['codex_otel', '2026-07-01T11:00:00Z'],
    ]);
  });
});
