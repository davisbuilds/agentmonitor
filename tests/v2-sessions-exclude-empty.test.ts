import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let listBrowsingSessions: typeof import('../src/db/v2-queries.js').listBrowsingSessions;
/* eslint-enable @typescript-eslint/consistent-type-imports */

const FULL_CAPS = JSON.stringify({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' });
const SUMMARY_LIVE_CAPS = JSON.stringify({ history: 'none', search: 'none', tool_analytics: 'none', live_items: 'summary' });

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-exclude-empty-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  initSchema = (await import('../src/db/schema.js')).initSchema;
  listBrowsingSessions = (await import('../src/db/v2-queries.js')).listBrowsingSessions;

  initSchema();
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO browsing_sessions
      (id, project, agent, first_message, started_at, message_count, user_message_count, integration_mode, fidelity, capabilities_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Full transcript with real conversation — keep.
  insert.run('full-1', 'p', 'claude', 'Hello there', '2026-03-06T12:00:00Z', 40, 20, 'claude-jsonl', 'full', FULL_CAPS);
  // Full transcript that opened with a local command (no preview) but has user turns — keep.
  insert.run('full-noprev', 'p', 'claude', '<command-name>/compact</command-name><command-message>x</command-message><command-args></command-args>', '2026-03-06T11:00:00Z', 5, 5, 'claude-jsonl', 'full', FULL_CAPS);
  // Telemetry-only live-summary session: no browsable history — strip.
  insert.run('summary-1', 'p', 'codex', null, '2026-03-06T10:00:00Z', 422, 0, 'otel', 'summary', SUMMARY_LIVE_CAPS);
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('listBrowsingSessions returns every session by default', () => {
  const res = listBrowsingSessions({});
  assert.equal(res.total, 3);
  assert.deepEqual(res.data.map((s) => s.id).sort(), ['full-1', 'full-noprev', 'summary-1']);
});

test('exclude_empty drops sessions with no browsable history and adjusts the total', () => {
  const res = listBrowsingSessions({ exclude_empty: true });
  assert.equal(res.total, 2, 'total should not count the excluded summary-only session');
  assert.deepEqual(res.data.map((s) => s.id).sort(), ['full-1', 'full-noprev']);
  assert.ok(!res.data.some((s) => s.id === 'summary-1'), 'summary-only session must be excluded');
});
