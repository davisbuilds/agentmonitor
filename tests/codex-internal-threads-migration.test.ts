import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-internal-migration-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema, runDataMigrations } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const truncated = JSON.stringify({ _truncated: true, _original_bytes: 24000 });
const id = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

test('v24 marks the Codex threads no one started as internal, and leaves real sessions alone', () => {
  const db = getDb();
  const session = db.prepare(`INSERT INTO browsing_sessions (id, agent, integration_mode, relationship_type, started_at)
    VALUES (?, 'codex', ?, ?, '2026-10-20T10:00:00Z')`);
  const event = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, model, metadata, source)
    VALUES (?, 'codex', ?, ?, ?, 'otel')`);

  // An approval review: only its model marks it.
  session.run(id(1), 'codex-otel', null);
  event.run(id(1), 'session_start', 'codex-auto-review', '{}');
  // An app job whose prompt the size cap dropped, with no rollout anywhere.
  session.run(id(2), 'codex-otel', null);
  event.run(id(2), 'user_prompt', 'gpt-5.6-terra', truncated);
  // A long first prompt in a real session: it saved a rollout, so it stays.
  session.run(id(3), 'codex-otel', null);
  event.run(id(3), 'user_prompt', 'gpt-6-astra', truncated);
  session.run(`rollout-2026-10-20T10-00-00-${id(3)}`, 'codex-jsonl', null);
  // A session whose prompt survived and names no app job.
  session.run(id(4), 'codex-otel', null);
  event.run(id(4), 'user_prompt', 'gpt-6-astra', JSON.stringify({ message: 'Fix the flaky test' }));
  // A reviewer already classified another way keeps its classification.
  session.run(id(5), 'codex-otel', 'subagent');
  event.run(id(5), 'session_start', 'codex-auto-review', '{}');

  db.pragma('user_version = 23');
  runDataMigrations(db);

  const relationship = (n: number) => (db.prepare('SELECT relationship_type FROM browsing_sessions WHERE id = ?')
    .get(id(n)) as { relationship_type: string | null }).relationship_type;
  assert.deepEqual([1, 2, 3, 4, 5].map(relationship), ['internal', 'internal', null, null, 'subagent']);
  assert.equal(db.pragma('user_version', { simple: true }), 24);
});
