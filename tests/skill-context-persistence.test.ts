import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-skill-context-'));
process.env['AGENTMONITOR_DB_PATH'] = path.join(tempDir, 'test.db');
process.env['AGENTMONITOR_SKILL_DIRS'] = path.join(tempDir, 'skills');

let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let insertParsedSession: typeof import('../src/parser/claude-code.js').insertParsedSession;
let parseCodexSessionMessages: typeof import('../src/parser/codex-sessions.js').parseCodexSessionMessages;

before(async () => {
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  const { initSchema } = await import('../src/db/schema.js');
  ({ insertParsedSession } = await import('../src/parser/claude-code.js'));
  ({ parseCodexSessionMessages } = await import('../src/parser/codex-sessions.js'));
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function source(skill: string): string {
  return [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-01T00:00:00Z',
      payload: { cwd: '/work/project' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:01Z',
      payload: {
        role: 'developer',
        content: [{
          type: 'input_text',
          text: `<skills_instructions><skills><skill><name>${skill}</name><description>desc</description></skill></skills></skills_instructions>`,
        }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:02Z',
      payload: {
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: `cat /skills/${skill}/SKILL.md` }),
      },
    }),
  ].join('\n');
}

test('session reparse atomically replaces observations and catalog entries', () => {
  const first = parseCodexSessionMessages(source('alpha'), 'persist-session');
  insertParsedSession(getDb(), first, '/tmp/persist.jsonl', 1, 'first');

  assert.equal(
    (getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM session_context_observations
      WHERE session_id = ?
    `).get('persist-session') as { count: number }).count,
    2,
  );

  const second = parseCodexSessionMessages(source('beta'), 'persist-session');
  insertParsedSession(getDb(), second, '/tmp/persist.jsonl', 2, 'second');
  assert.deepEqual(
    getDb().prepare(`
      SELECT skill_name
      FROM session_context_observations
      WHERE session_id = ? AND skill_name IS NOT NULL
    `).all('persist-session'),
    [{ skill_name: 'beta' }],
  );
  assert.deepEqual(
    getDb().prepare(`
      SELECT entry.skill_name
      FROM session_catalog_observation_entries entry
      JOIN session_context_observations observation ON observation.id = entry.observation_id
      WHERE observation.session_id = ?
    `).all('persist-session'),
    [{ skill_name: 'beta' }],
  );

  const invalid = structuredClone(second);
  if (!invalid.skillContext) throw new Error('fixture must contain skill context');
  invalid.skillContext.observations[0]!.kind = 'invalid' as 'consultation';
  assert.throws(
    () => insertParsedSession(getDb(), invalid, '/tmp/persist.jsonl', 3, 'invalid'),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    getDb().prepare(`
      SELECT skill_name
      FROM session_context_observations
      WHERE session_id = ? AND skill_name IS NOT NULL
    `).all('persist-session'),
    [{ skill_name: 'beta' }],
  );
});
