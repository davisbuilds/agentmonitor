import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import test, { after, before } from 'node:test';
import type * as Connection from '../src/db/connection.js';
import type * as Watcher from '../src/watcher/index.js';
import { CODEX_CONTEXT_EVIDENCE_VERSION } from '../src/skills/codex-evidence-version.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-codex-context-refresh-'));
const scratchDb = path.join(scratch, 'test.db');
process.env.AGENTMONITOR_DB_PATH = scratchDb;
let connection: typeof Connection;
let watcher: typeof Watcher;

before(async () => {
  connection = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  assert.equal(connection.getDb().name, scratchDb);
  watcher = await import('../src/watcher/index.js');
});
after(() => {
  connection?.closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function userMessage(content: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: '2026-11-27T00:01:00Z',
    payload: { role: 'user', content: [{ type: 'input_text', text: content }] },
  }) + '\n';
}

function fixture(compressed = false) {
  const db = connection.getDb();
  const uuid = randomUUID();
  const codexHome = path.join(scratch, uuid);
  const sessionsDir = path.join(codexHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = `rollout-2026-11-27T00-00-00-${uuid}`;
  const filePath = path.join(sessionsDir, sessionId + (compressed ? '.jsonl.zst' : '.jsonl'));
  const body = JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-11-27T00:00:00Z',
    payload: { id: uuid, cwd: '/work/example' },
  }) + '\n' + userMessage('previous message');
  fs.writeFileSync(filePath, compressed ? zstdCompressSync(Buffer.from(body)) : body);
  assert.equal(watcher.syncCodexSessionFileDetailed(db, filePath).result, 'parsed');
  db.prepare(`
    UPDATE browsing_sessions SET skill_context_capabilities_json =
      json_remove(skill_context_capabilities_json, '$.codexEvidenceVersion') WHERE id = ?
  `).run(sessionId);
  db.prepare(`
    INSERT INTO session_context_observations (session_id, ordinal, kind, source)
    VALUES (?, 42, 'catalog_presentation', 'legacy_unverified')
  `).run(sessionId);
  const sync = () => watcher.syncCodexSessionFileDetailed(db, filePath);
  const stored = () => db.prepare(`
    SELECT skill_context_capabilities_json, file_hash, message_count FROM browsing_sessions WHERE id = ?
  `).get(sessionId) as { skill_context_capabilities_json: string; file_hash: string; message_count: number };
  const observations = () => db.prepare(
    'SELECT source FROM session_context_observations WHERE session_id = ? ORDER BY id',
  ).all(sessionId);
  const turns = () => db.prepare('SELECT title FROM session_turns WHERE session_id = ? ORDER BY id').all(sessionId);
  const version = () => JSON.parse(stored().skill_context_capabilities_json).codexEvidenceVersion as unknown;
  return { db, codexHome, filePath, sync, stored, observations, turns, version };
}

for (const compressed of [false, true]) {
  test(`normal sweep refreshes unchanged ${compressed ? 'compressed' : 'plain'} legacy evidence once`, () => {
    const fixtureState = fixture(compressed);
    const { db, codexHome, filePath, stored, observations, version } = fixtureState;
    const mtime = fs.statSync(filePath).mtimeMs;
    const { file_hash: hash } = stored();
    assert.equal(version(), undefined);
    assert.deepEqual(observations(), [{ source: 'legacy_unverified' }]);
    assert.deepEqual(watcher.syncAllCodexFiles(db, codexHome), { parsed: 1, skipped: 0, errors: 0, total: 1 });
    assert.equal(version(), CODEX_CONTEXT_EVIDENCE_VERSION);
    assert.deepEqual(observations(), []);
    assert.equal(stored().file_hash, hash);
    assert.equal(fs.statSync(filePath).mtimeMs, mtime);
    assert.deepEqual(watcher.syncAllCodexFiles(db, codexHome), { parsed: 0, skipped: 1, errors: 0, total: 1 });
  });
}

test('a legacy append bypasses its checkpoint and replaces stale evidence', () => {
  const { filePath, sync, stored, observations, version } = fixture();
  fs.appendFileSync(filePath, userMessage('appended message'));
  assert.equal(sync().parse, 'full');
  assert.equal(version(), CODEX_CONTEXT_EVIDENCE_VERSION);
  assert.equal(stored().message_count, 2);
  assert.deepEqual(observations(), []);
});

test('a failed downstream publication leaves the previous projection intact for retry', () => {
  const { db, filePath, sync, stored, observations, turns, version } = fixture();
  const previous = { row: stored(), observations: observations(), turns: turns() };
  fs.appendFileSync(filePath, userMessage('appended message'));
  db.exec(`
    CREATE TEMP TRIGGER block_evidence_refresh BEFORE INSERT ON session_turns
    BEGIN SELECT RAISE(ABORT, 'fixture publication failure'); END
  `);
  try {
    assert.equal(sync().result, 'error');
    assert.deepEqual({ row: stored(), observations: observations(), turns: turns() }, previous);
  } finally {
    db.exec('DROP TRIGGER block_evidence_refresh');
  }
  assert.equal(sync().parse, 'full');
  assert.equal(version(), CODEX_CONTEXT_EVIDENCE_VERSION);
  assert.deepEqual(observations(), []);
  assert.deepEqual(turns(), [{ title: 'previous message' }, { title: 'appended message' }]);
  assert.equal(sync().result, 'skipped');
});

test('paginated replay keeps historical catalog time without borrowing the replacement build', () => {
  const db = connection.getDb();
  const dir = path.join(scratch, randomUUID(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const originalId = randomUUID();
  const replacementId = randomUUID();
  const firstTime = '2026-11-26T00:00:00Z';
  const secondTime = '2026-11-27T00:00:00Z';
  const originalIdForBrowser = `rollout-2026-11-26T00-00-00-${originalId}`;
  const original = path.join(dir, originalIdForBrowser + '.jsonl');
  const replacement = path.join(dir, `rollout-2026-11-27T00-00-00-${replacementId}.jsonl`);
  const meta = (ordinal: number, timestamp: string, cliVersion: string, historyBase?: object) => ({
    ordinal, type: 'session_meta', timestamp, payload: {
      id: originalId, cwd: '/work/example', cli_version: cliVersion, history_mode: 'paginated', history_base: historyBase,
    },
  });
  const catalog = {
    ordinal: 1, type: 'response_item', timestamp: firstTime, payload: {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: [
        '<skills_instructions>', '## Host skills', '### Available skills',
        '- historical: Example skill. (file: /skills/historical/SKILL.md)', '</skills_instructions>',
      ].join('\n') }],
    },
  };
  const scope = {
    ordinal: 2, type: 'turn_context', timestamp: firstTime, payload: { cwd: '/work/example', model: 'fixture-model' },
  };
  const prefix = [meta(0, firstTime, '0.160.0'), catalog, scope].map(value => JSON.stringify(value)).join('\n') + '\n';
  fs.writeFileSync(original, prefix);
  const replacementHeader = meta(3, secondTime, '0.170.0', {
    thread_id: originalId, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix),
  });
  fs.writeFileSync(replacement, [
    replacementHeader,
    { ...JSON.parse(userMessage('continued message')), ordinal: 4 },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');

  assert.equal(watcher.syncCodexSessionFileDetailed(db, replacement).result, 'parsed');
  assert.deepEqual(db.prepare(`
    SELECT observed_at, json_extract(metadata_json, '$.runtime.harnessVersion') AS build
    FROM session_context_observations WHERE session_id = ? AND kind = 'catalog_presentation'
  `).all(originalIdForBrowser), [{ observed_at: firstTime, build: null }]);
});
