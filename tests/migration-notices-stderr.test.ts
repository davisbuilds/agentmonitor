import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Migration notices are diagnostics; they must go to stderr, never stdout.
// A CLI read command runs initSchema() before printing, so a `[migration]`
// line on stdout would corrupt `--json` output for agents on first run after
// an upgrade. This asserts the notices land on stderr.

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let runDataMigrations: typeof import('../src/db/schema.js').runDataMigrations;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-migration-stderr-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  ({ initSchema, runDataMigrations } = await import('../src/db/schema.js'));
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('migration notices are written to stderr, not stdout', () => {
  // Rewind so the occupancy backfill (v2) re-runs against a seeded row and emits.
  getDb().pragma('user_version = 1');
  getDb()
    .prepare('INSERT INTO browsing_sessions (id, agent, file_path, context_used_tokens) VALUES (?, ?, ?, ?)')
    .run('claude-null', 'claude', '/fake/claude-null.jsonl', null);
  getDb()
    .prepare('INSERT INTO watched_files (file_path, file_hash, status) VALUES (?, ?, ?)')
    .run('/fake/claude-null.jsonl', 'h', 'parsed');

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { stdoutLines.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { stderrLines.push(args.join(' ')); };
  try {
    runDataMigrations(getDb());
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  assert.ok(
    stderrLines.some(line => line.includes('[migration]')),
    'expected a [migration] notice on stderr',
  );
  assert.ok(
    !stdoutLines.some(line => line.includes('[migration]')),
    `no [migration] notice may reach stdout; saw: ${stdoutLines.join(' | ')}`,
  );
});
