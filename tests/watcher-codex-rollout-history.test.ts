import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import test, { after, before } from 'node:test';
import type * as Watcher from '../src/watcher/index.js';
import type * as Connection from '../src/db/connection.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-watcher-history-'));
process.env.AGENTMONITOR_DB_PATH = path.join(scratch, 'test.db');
let watcher: typeof Watcher;
let connection: typeof Connection;

before(async () => {
  connection = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  watcher = await import('../src/watcher/index.js');
  assert.equal(connection.getDb().name, path.join(scratch, 'test.db'));
});
after(() => {
  connection.closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

let fixtureNumber = 0;
function fixture() {
  const serial = ++fixtureNumber;
  const rootId = `11111111-1111-4111-8111-${String(serial).padStart(12, '0')}`;
  const leafId = `22222222-2222-4222-8222-${String(serial).padStart(12, '0')}`;
  const dir = path.join(scratch, `fixture-${serial}`, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const root = path.join(dir, `rollout-2026-11-01T00-00-00-${rootId}.jsonl`);
  const leaf = path.join(dir, `rollout-2026-11-02T00-00-00-${leafId}.jsonl`);
  const meta = (ordinal: number, timestamp: string, extra = {}) => ({ ordinal, type: 'session_meta', timestamp,
    payload: { id: rootId, cwd: '/work/example', source: 'cli', originator: 'codex_cli_rs', timestamp: '2026-11-01T00:00:00Z', ...extra } });
  const message = (ordinal: number, text: string) => ({ ordinal, type: 'response_item', timestamp: `2026-11-01T00:00:0${ordinal}Z`,
    payload: { role: 'user', content: [{ type: 'input_text', text }] } });
  const prefix = [meta(0, '2026-11-01T00:00:00Z', { history_mode: 'paginated' }), message(1, 'original request')].map(record => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(root, prefix + JSON.stringify(message(2, 'discarded old tail')) + '\n');
  const writeLeaf = (compressed = false, missing = false) => {
    const content = [meta(2, '2026-11-02T00:00:00Z', { history_mode: 'paginated', history_base: {
      thread_id: missing ? '99999999-9999-4999-8999-999999999999' : rootId,
      end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(prefix),
    } }), message(3, 'continued request')].map(record => JSON.stringify(record)).join('\n') + '\n';
    const file = compressed ? leaf + '.zst' : leaf;
    fs.writeFileSync(file, compressed ? zstdCompressSync(Buffer.from(content)) : content);
    return file;
  };
  const browserId = path.basename(root, '.jsonl');
  const contents = () => connection.getDb().prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY ordinal').all(browserId)
    .map(row => JSON.parse((row as { content: string }).content) as Array<{ text: string }>).flat().map(block => block.text);
  return { root, leaf, rootId, leafId, dir, writeLeaf, browserId, contents, message };
}

test('pagination keeps the root browser identity and exact selected history, including forced old-file sync', () => {
  const f = fixture();
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'discarded old tail']);
  const leaf = f.writeLeaf();
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'continued request']);
  const rows = connection.getDb().prepare('SELECT id, file_path FROM browsing_sessions WHERE file_path IN (?, ?)').all(f.root, leaf);
  assert.deepEqual(rows, [{ id: f.browserId, file_path: leaf }]);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root, { force: true }).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'continued request']);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'skipped');
  fs.appendFileSync(leaf, JSON.stringify(f.message(4, 'appended request')) + '\n');
  const append = watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf);
  assert.equal(append.parse, 'resumed');
  assert.deepEqual(f.contents(), ['original request', 'continued request', 'appended request']);
});

test('a missing active history dependency preserves the previous complete browser projection', () => {
  const f = fixture();
  watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root);
  const before = f.contents();
  f.writeLeaf(false, true);
  const outcome = watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root, { force: true });
  assert.equal(outcome.result, 'error');
  assert.deepEqual(f.contents(), before);
});

test('compressed pagination is selected without creating a separate browser row', () => {
  const f = fixture();
  watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root);
  const leaf = f.writeLeaf(true);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'continued request']);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root).result, 'skipped');
  assert.deepEqual(watcher.findMissingSessionProjections(connection.getDb(), [f.root, leaf]), []);
});

test('native creation time selects the newest revert branch before filename, mtime or discovery order', () => {
  const f = fixture();
  const older = f.writeLeaf();
  const newer = path.join(f.dir, `rollout-2026-11-03T00-00-00-00000000-0000-4000-8000-000000000000.jsonl`);
  const records = fs.readFileSync(older, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  records[0].timestamp = '2026-11-01T22:00:00.123-04:00';
  records[1].payload.content[0].text = 'newest branch';
  fs.writeFileSync(newer, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  fs.utimesSync(older, new Date('2030-01-01'), new Date('2030-01-01'));
  fs.utimesSync(newer, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), older, { force: true }).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'newest branch']);
});

test('ancestor prefix edits invalidate the logical checkpoint while bytes beyond its bookmark do not', () => {
  const f = fixture();
  const leaf = f.writeLeaf();
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'parsed');
  fs.appendFileSync(f.root, JSON.stringify(f.message(3, 'another discarded tail')) + '\n');
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'skipped');
  fs.writeFileSync(f.root, fs.readFileSync(f.root, 'utf8').replace('original request', 'modified request'));
  const updated = watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf);
  assert.equal(updated.parse, 'full');
  assert.deepEqual(f.contents(), ['modified request', 'continued request']);
});

test('a compressed ancestor resolves using decoded byte bookmarks', () => {
  const f = fixture();
  const leaf = f.writeLeaf();
  fs.writeFileSync(f.root + '.zst', zstdCompressSync(fs.readFileSync(f.root)));
  fs.unlinkSync(f.root);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'continued request']);
});

test('a malformed newest history pointer cannot be hidden by the header inventory', () => {
  const f = fixture();
  const leaf = f.writeLeaf();
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'parsed');
  const before = f.contents();
  const records = fs.readFileSync(leaf, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  records[0].payload.history_base.end_byte_offset = 'invalid';
  fs.writeFileSync(leaf, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root, { force: true }).result, 'error');
  assert.deepEqual(f.contents(), before);
});

test('a discovered sweep resolves pagination once and stores one complete browser projection', () => {
  const f = fixture();
  f.writeLeaf();
  assert.deepEqual(watcher.syncAllCodexFiles(connection.getDb(), path.dirname(f.dir)), {
    parsed: 1, skipped: 1, errors: 0, total: 2,
  });
  assert.deepEqual(f.contents(), ['original request', 'continued request']);
  assert.deepEqual(watcher.findMissingSessionProjections(connection.getDb(), [f.root, f.leaf]), []);
});


test('an invalid active creation timestamp preserves the previous complete projection', () => {
  const f = fixture();
  const leaf = f.writeLeaf();
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), leaf).result, 'parsed');
  const before = f.contents();
  const records = fs.readFileSync(leaf, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  records[0].timestamp = 'invalid';
  fs.writeFileSync(leaf, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root, { force: true }).result, 'error');
  assert.deepEqual(f.contents(), before);
});

test('an unchanged compressed root with paginated mode skips without decoding its immutable bytes', () => {
  const f = fixture();
  const compressed = f.root + '.zst';
  fs.writeFileSync(compressed, zstdCompressSync(fs.readFileSync(f.root)));
  fs.unlinkSync(f.root);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), compressed).result, 'parsed');
  assert.deepEqual(f.contents(), ['original request', 'discarded old tail']);
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), compressed).result, 'skipped');
  // Positive control above proves this file produces a complete projection.
  // Once parsed, its unchanged mtime should suffice even if reads now fail.
  fs.chmodSync(compressed, 0o000);
  try {
    assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), compressed).result, 'skipped');
    assert.deepEqual(f.contents(), ['original request', 'discarded old tail']);
  } finally {
    fs.chmodSync(compressed, 0o644);
  }
});

test('a replacement rollout with full history and no base retains the original browser identity', () => {
  const f = fixture();
  assert.equal(watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root).result, 'parsed');
  const leaf = f.writeLeaf();
  const records = fs.readFileSync(leaf, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  records[0].payload.history_mode = 'full';
  delete records[0].payload.history_base;
  fs.writeFileSync(leaf, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const replacement = watcher.syncCodexSessionFileDetailed(connection.getDb(), f.root, { force: true });
  assert.equal(replacement.session_id, f.browserId);
  assert.equal(replacement.result, 'parsed');
  assert.deepEqual(f.contents(), ['continued request']);
  assert.deepEqual(connection.getDb().prepare('SELECT id, file_path FROM browsing_sessions WHERE id = ?').get(f.browserId),
    { id: f.browserId, file_path: leaf });
});
