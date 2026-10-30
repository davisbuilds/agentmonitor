import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-zst-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_AUTO_IMPORT_MINUTES = '0';

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { runImport } = await import('../src/import/index.js');
const watcher = await import('../src/watcher/index.js');

initSchema();
assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const SESSION = '019f0000-0000-7000-8000-000000000001';
const codexDir = path.join(tempDir, 'codex');
const sessionsDir = path.join(codexDir, 'sessions', '2026', '07', '12');
fs.mkdirSync(sessionsDir, { recursive: true });
const rolloutId = `rollout-2026-07-12T10-00-00-${SESSION}`;
const plain = path.join(sessionsDir, `${rolloutId}.jsonl`);
const compressed = `${plain}.zst`;

const lines = [
  { type: 'session_meta', timestamp: '2026-07-12T10:00:00Z', payload: { id: SESSION, cwd: '/work/beta', timestamp: '2026-07-12T10:00:00Z', source: 'cli' } },
  { type: 'turn_context', timestamp: '2026-07-12T10:00:01Z', payload: { model: 'gpt-5.6-terra' } },
  { type: 'response_item', timestamp: '2026-07-12T10:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the parser' }] } },
  { type: 'response_item', timestamp: '2026-07-12T10:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ported.' }] } },
  { type: 'event_msg', timestamp: '2026-07-12T10:00:06Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 80 } } } },
].map(line => JSON.stringify(line)).join('\n');

const db = () => getDb();
const session = () => db().prepare('SELECT COUNT(*) AS rows, MAX(message_count) AS messages, MAX(cwd) AS cwd FROM browsing_sessions WHERE id = ?')
  .get(rolloutId) as { rows: number; messages: number | null; cwd: string | null };
const storedMessages = () => (db().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(rolloutId) as { n: number }).n;
const usageRows = () => (db().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND event_id LIKE 'import-cdx-%'").get(SESSION) as { n: number }).n;

test('a rollout Codex compressed after amon read it stays one session, with nothing imported twice', () => {
  fs.writeFileSync(plain, lines);
  assert.equal(watcher.syncCodexSessionFileDetailed(db(), plain).result, 'parsed');
  runImport({ source: 'codex', codexDir });
  const before = { session: session(), messages: storedMessages(), usage: usageRows() };
  assert.deepEqual(before.session, { rows: 1, messages: 2, cwd: '/work/beta' });
  assert.ok(before.usage > 0);

  // Codex compresses the finished rollout and removes the plain file.
  fs.writeFileSync(compressed, zstdCompressSync(fs.readFileSync(plain)));
  fs.rmSync(plain);
  assert.deepEqual(watcher.discoverCodexSessionFiles(codexDir).map(file => path.basename(file)), [`${rolloutId}.jsonl.zst`]);
  assert.equal(watcher.syncCodexSessionFileDetailed(db(), compressed, { force: true }).result, 'parsed');
  const imported = runImport({ source: 'codex', codexDir });

  assert.deepEqual(session(), before.session, 'the compressed file rebuilds the same session row');
  assert.equal(storedMessages(), before.messages);
  assert.equal(usageRows(), before.usage, 'its usage events dedupe against the ones already imported');
  assert.equal(imported.files.find(file => file.path === compressed)?.eventsImported, 0);

  // Import state records the size on disk, so the next pass skips the file
  // without reading and decompressing it.
  assert.equal((db().prepare('SELECT file_size FROM import_state WHERE file_path = ?').get(compressed) as { file_size: number }).file_size,
    fs.statSync(compressed).size);
  assert.equal(runImport({ source: 'codex', codexDir }).files.find(file => file.path === compressed)?.skippedUnchanged, true);
});

test('a rollout amon first sees compressed is read whole', () => {
  const id = '019f0000-0000-7000-8000-000000000002';
  const otherId = `rollout-2026-07-12T11-00-00-${id}`;
  const file = path.join(sessionsDir, `${otherId}.jsonl.zst`);
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(lines.replaceAll(SESSION, id))));
  assert.equal(watcher.syncCodexSessionFileDetailed(db(), file).result, 'parsed');
  assert.deepEqual(db().prepare('SELECT message_count, cwd FROM browsing_sessions WHERE id = ?').get(otherId), { message_count: 2, cwd: '/work/beta' });
  assert.equal(watcher.syncCodexSessionFileDetailed(db(), file).result, 'skipped', 'an unchanged compressed file is skipped like any other');
});
