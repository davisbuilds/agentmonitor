import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let tempDir = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let runDataMigrations: typeof import('../src/db/schema.js').runDataMigrations;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-occ-migration-'));
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

function seedSession(id: string, agent: string, usedTokens: number | null, hash: string): void {
  const filePath = `/fake/${id}.jsonl`;
  getDb()
    .prepare('INSERT INTO browsing_sessions (id, agent, file_path, context_used_tokens) VALUES (?, ?, ?, ?)')
    .run(id, agent, filePath, usedTokens);
  getDb()
    .prepare('INSERT INTO watched_files (file_path, file_hash, status) VALUES (?, ?, ?)')
    .run(filePath, hash, 'parsed');
}

function hashOf(sessionId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT file_hash FROM watched_files WHERE file_path = ?')
    .get(`/fake/${sessionId}.jsonl`) as { file_hash: string } | undefined;
  return row?.file_hash;
}

test('the occupancy backfill migration invalidates only null-occupancy Claude/Codex watched files', () => {
  // initSchema already ran migrations to the current version; rewind so our
  // seeded rows are present when the occupancy migration (v2) runs.
  getDb().pragma('user_version = 1');

  seedSession('claude-null', 'claude', null, 'h-claude-null');
  seedSession('claude-occ', 'claude', 250_000, 'h-claude-occ');
  seedSession('codex-null', 'codex', null, 'h-codex-null');
  seedSession('anti-null', 'antigravity', null, 'h-anti-null');
  // A watched file with no browsing_sessions row must be left alone.
  getDb().prepare('INSERT INTO watched_files (file_path, file_hash, status) VALUES (?, ?, ?)')
    .run('/fake/orphan.jsonl', 'h-orphan', 'parsed');

  runDataMigrations(getDb());

  // Null-occupancy Claude/Codex files are invalidated so the watcher reparses them.
  assert.equal(hashOf('claude-null'), '', 'claude null-occupancy invalidated');
  assert.equal(hashOf('codex-null'), '', 'codex null-occupancy invalidated');
  // Already-populated and non-live agents are untouched.
  assert.equal(hashOf('claude-occ'), 'h-claude-occ', 'populated session untouched');
  assert.equal(hashOf('anti-null'), 'h-anti-null', 'antigravity (always-null) untouched');
  assert.equal(
    (getDb().prepare('SELECT file_hash FROM watched_files WHERE file_path = ?').get('/fake/orphan.jsonl') as { file_hash: string }).file_hash,
    'h-orphan',
    'orphan watched file untouched',
  );
  // The version counter advanced so it will not run again.
  assert.ok((getDb().pragma('user_version', { simple: true }) as number) >= 2);
});

test('the migration is a no-op once the version counter has advanced', () => {
  // Re-invalidate a hash by hand; a second run must not touch it (guarded).
  getDb().prepare('UPDATE watched_files SET file_hash = ? WHERE file_path = ?')
    .run('restored', '/fake/claude-null.jsonl');
  runDataMigrations(getDb());
  assert.equal(hashOf('claude-null'), 'restored', 'no re-run after version bump');
});
