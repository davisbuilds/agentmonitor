import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type {
  syncCodexSessionFile as syncCodexSessionFileFn,
  syncCodexSessionFileDetailed as syncCodexSessionFileDetailedFn,
  syncSessionFile as syncSessionFileFn,
  syncSessionFileDetailed as syncSessionFileDetailedFn,
} from '../src/watcher/index.js';

let tempDir = '';
let dbDir = '';
let watchDir = '';
let codexWatchDir = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-watcher-'));
  dbDir = path.join(tempDir, 'db');
  watchDir = path.join(tempDir, 'watch', 'projects', '-Users-dev-Dev-testproject');
  codexWatchDir = path.join(tempDir, 'codex', 'sessions', '2026', '03', '06');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(codexWatchDir, { recursive: true });

  process.env.AGENTMONITOR_DB_PATH = path.join(dbDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sampleJsonl(lines: object[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function writeSessionFile(sessionId: string, content: string): string {
  const filePath = path.join(watchDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeCodexSessionFile(sessionId: string, content: string): string {
  const filePath = path.join(codexWatchDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const makeSession = (sessionId: string) => sampleJsonl([
  {
    type: 'user',
    parentUuid: null,
    sessionId,
    cwd: '/Users/dev/Dev/testproject',
    message: { role: 'user', content: [{ type: 'text', text: `Hello from session ${sessionId}` }] },
    timestamp: '2026-03-06T10:00:00.000Z',
  },
  {
    type: 'assistant',
    parentUuid: 'u1',
    sessionId,
    cwd: '/Users/dev/Dev/testproject',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there! How can I help?' }],
    },
    timestamp: '2026-03-06T10:00:05.000Z',
  },
]);

const makeCodexSession = (sessionId: string) => sampleJsonl([
  {
    type: 'session_meta',
    timestamp: '2026-03-06T10:00:00.000Z',
    payload: {
      id: sessionId,
      cwd: '/Users/dev/Dev/testproject',
      timestamp: '2026-03-06T10:00:00.000Z',
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-03-06T10:00:05.000Z',
    payload: {
      role: 'user',
      content: [{ type: 'text', text: `Hello from codex session ${sessionId}` }],
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-03-06T10:00:10.000Z',
    payload: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Codex can help here.' }],
    },
  },
]);

describe('syncSessionFile', () => {
  let syncSessionFile: typeof syncSessionFileFn;
  let syncSessionFileDetailed: typeof syncSessionFileDetailedFn;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    syncSessionFile = mod.syncSessionFile;
    syncSessionFileDetailed = mod.syncSessionFileDetailed;
  });

  test('parses and inserts a new session file', () => {
    const db = getDb();
    const sessionId = 'new-sess-001';
    const filePath = writeSessionFile(sessionId, makeSession(sessionId));

    const result = syncSessionFile(db, filePath);
    assert.equal(result, 'parsed');

    // Verify data in DB
    const session = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
    assert.ok(session, 'session should exist');
    assert.equal(session.message_count, 2);

    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(sessionId);
    assert.equal(messages.length, 2);

    // Verify watched_files record
    const watched = db.prepare('SELECT * FROM watched_files WHERE file_path = ?').get(filePath) as Record<string, unknown>;
    assert.ok(watched, 'watched_files record should exist');
    assert.equal(watched.status, 'parsed');
  });

  test('detailed sync populates live tables and returns delta counts', () => {
    const db = getDb();
    const sessionId = 'live-detailed-001';
    const filePath = writeSessionFile(sessionId, makeSession(sessionId));

    const outcome = syncSessionFileDetailed(db, filePath);
    assert.equal(outcome.result, 'parsed');
    assert.equal(outcome.session_id, sessionId);
    assert.ok(outcome.live, 'should include live sync metadata');
    assert.equal(outcome.live!.inserted_turns, 2);
    assert.ok(outcome.live!.inserted_items >= 2);

    const turns = (db.prepare('SELECT COUNT(*) as c FROM session_turns WHERE session_id = ?').get(sessionId) as { c: number }).c;
    const items = (db.prepare('SELECT COUNT(*) as c FROM session_items WHERE session_id = ?').get(sessionId) as { c: number }).c;
    assert.equal(turns, 2);
    assert.ok(items >= 2);
  });

  test('skips file with unchanged hash', () => {
    const db = getDb();
    const sessionId = 'skip-sess-001';
    const filePath = writeSessionFile(sessionId, makeSession(sessionId));

    // First parse
    const result1 = syncSessionFile(db, filePath);
    assert.equal(result1, 'parsed');

    // Second parse — same content, should skip
    const result2 = syncSessionFile(db, filePath);
    assert.equal(result2, 'skipped');
  });

  test('re-parses file with changed hash', () => {
    const db = getDb();
    const sessionId = 'changed-sess-001';
    const content1 = makeSession(sessionId);
    const filePath = writeSessionFile(sessionId, content1);

    syncSessionFile(db, filePath);

    // Modify file — add another message
    const content2 = content1 + JSON.stringify({
      type: 'user',
      parentUuid: 'u2',
      sessionId,
      cwd: '/Users/dev/Dev/testproject',
      message: { role: 'user', content: [{ type: 'text', text: 'One more question' }] },
      timestamp: '2026-03-06T10:02:00.000Z',
    }) + '\n';
    fs.writeFileSync(filePath, content2);

    const result = syncSessionFile(db, filePath);
    assert.equal(result, 'parsed');

    // Should now have 3 messages
    const count = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number }).c;
    assert.equal(count, 3);
  });

  test('handles empty/invalid JSONL files gracefully', () => {
    const db = getDb();
    const filePath = writeSessionFile('empty-sess', '');
    const result = syncSessionFile(db, filePath);
    // Should mark as skipped (no messages to parse)
    assert.ok(result === 'skipped' || result === 'parsed');
  });

  test('records error state for missing files', () => {
    const db = getDb();
    const fakePath = path.join(watchDir, 'nonexistent-file.jsonl');
    const result = syncSessionFile(db, fakePath);
    assert.equal(result, 'error');

    // Should record error in watched_files
    const watched = db.prepare('SELECT status FROM watched_files WHERE file_path = ?').get(fakePath) as { status: string } | undefined;
    assert.ok(watched, 'should record error in watched_files');
    assert.equal(watched!.status, 'error');
  });

  test('empty-messages file is recorded as skipped in watched_files', () => {
    const db = getDb();
    // File with only non-message lines
    const content = JSON.stringify({ type: 'progress', sessionId: 'skip-only', data: {} }) + '\n';
    const filePath = writeSessionFile('skip-only-sess', content);
    const result = syncSessionFile(db, filePath);
    assert.equal(result, 'skipped');

    const watched = db.prepare('SELECT status FROM watched_files WHERE file_path = ?').get(filePath) as { status: string };
    assert.equal(watched.status, 'skipped');
  });

  test('retries unchanged Claude file after transient sync error', () => {
    const db = getDb();
    const sessionId = 'retry-claude-001';
    const filePath = writeSessionFile(sessionId, makeSession(sessionId));

    db.exec(`
      CREATE TRIGGER fail_claude_sync_once
      BEFORE INSERT ON browsing_sessions
      WHEN NEW.id = '${sessionId}'
      BEGIN
        SELECT RAISE(FAIL, 'forced Claude sync failure');
      END;
    `);

    const first = syncSessionFile(db, filePath);
    assert.equal(first, 'error');

    const watchedError = db.prepare(
      'SELECT status FROM watched_files WHERE file_path = ?',
    ).get(filePath) as { status: string } | undefined;
    assert.equal(watchedError?.status, 'error');

    db.exec('DROP TRIGGER fail_claude_sync_once');

    const second = syncSessionFile(db, filePath);
    assert.equal(second, 'parsed');
  });
});

describe('syncCodexSessionFile', () => {
  let syncCodexSessionFile: typeof syncCodexSessionFileFn;
  let syncCodexSessionFileDetailed: typeof syncCodexSessionFileDetailedFn;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    syncCodexSessionFile = mod.syncCodexSessionFile;
    syncCodexSessionFileDetailed = mod.syncCodexSessionFileDetailed;
  });

  test('parses and inserts a new Codex session file', () => {
    const db = getDb();
    const sessionId = 'codex-sess-001';
    const filePath = writeCodexSessionFile(sessionId, makeCodexSession(sessionId));

    const result = syncCodexSessionFile(db, filePath);
    assert.equal(result, 'parsed');

    const session = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
    assert.ok(session, 'session should exist');
    assert.equal(session.agent, 'codex');
    assert.equal(session.message_count, 2);

    const snapshot = db.prepare(
      'SELECT integration_mode, fidelity FROM browsing_sessions WHERE id = ?',
    ).get(sessionId) as { integration_mode: string; fidelity: string } | undefined;
    assert.ok(snapshot, 'live snapshot should exist');
    assert.equal(snapshot?.integration_mode, 'codex-jsonl');
    assert.equal(snapshot?.fidelity, 'summary');
  });

  test('detailed Codex sync populates live tables and returns delta counts', () => {
    const db = getDb();
    const sessionId = 'codex-live-001';
    const filePath = writeCodexSessionFile(sessionId, makeCodexSession(sessionId));

    const outcome = syncCodexSessionFileDetailed(db, filePath);
    assert.equal(outcome.result, 'parsed');
    assert.equal(outcome.session_id, sessionId);
    assert.ok(outcome.live, 'should include live sync metadata');
    assert.equal(outcome.live!.inserted_turns, 2);
    assert.ok(outcome.live!.inserted_items >= 2);
  });

  test('skips unchanged Codex file with matching hash', () => {
    const db = getDb();
    const sessionId = 'codex-skip-001';
    const filePath = writeCodexSessionFile(sessionId, makeCodexSession(sessionId));

    const result1 = syncCodexSessionFile(db, filePath);
    assert.equal(result1, 'parsed');

    const result2 = syncCodexSessionFile(db, filePath);
    assert.equal(result2, 'skipped');
  });

  test('retries unchanged Codex file after transient sync error', () => {
    const db = getDb();
    const sessionId = 'retry-codex-001';
    const filePath = writeCodexSessionFile(sessionId, makeCodexSession(sessionId));

    db.exec(`
      CREATE TRIGGER fail_codex_sync_once
      BEFORE INSERT ON browsing_sessions
      WHEN NEW.id = '${sessionId}'
      BEGIN
        SELECT RAISE(FAIL, 'forced Codex sync failure');
      END;
    `);

    const first = syncCodexSessionFile(db, filePath);
    assert.equal(first, 'error');

    const watchedError = db.prepare(
      'SELECT status FROM watched_files WHERE file_path = ?',
    ).get(filePath) as { status: string } | undefined;
    assert.equal(watchedError?.status, 'error');

    db.exec('DROP TRIGGER fail_codex_sync_once');

    const second = syncCodexSessionFile(db, filePath);
    assert.equal(second, 'parsed');
  });
});

describe('discoverSessionFiles', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let discoverSessionFiles: typeof import('../src/watcher/index.js').discoverSessionFiles;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    discoverSessionFiles = mod.discoverSessionFiles;
  });

  test('discovers JSONL files in projects directory', () => {
    // Write some session files
    writeSessionFile('discover-001', makeSession('discover-001'));
    writeSessionFile('discover-002', makeSession('discover-002'));
    const nestedDir = path.join(watchDir, 'nested', 'branch');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'discover-003.jsonl'), makeSession('discover-003'));

    const parentDir = path.join(tempDir, 'watch');
    const files = discoverSessionFiles(parentDir);
    assert.ok(files.length >= 3, `expected >= 3 files, got ${files.length}`);
    assert.ok(files.some(f => f.endsWith('discover-001.jsonl')));
    assert.ok(files.some(f => f.endsWith('discover-002.jsonl')));
    assert.ok(files.some(f => f.endsWith(path.join('nested', 'branch', 'discover-003.jsonl'))));
  });

  test('ignores non-JSONL files', () => {
    // Write a non-JSONL file
    fs.writeFileSync(path.join(watchDir, 'readme.txt'), 'not a session');

    const parentDir = path.join(tempDir, 'watch');
    const files = discoverSessionFiles(parentDir);
    assert.ok(!files.some(f => f.endsWith('.txt')), 'should not include .txt files');
  });

  test('supports exclude patterns during watcher discovery', () => {
    const excludedDir = path.join(watchDir, 'vercel-plugin');
    fs.mkdirSync(excludedDir, { recursive: true });
    fs.writeFileSync(path.join(excludedDir, 'skill-injections.jsonl'), '{}\n');

    const parentDir = path.join(tempDir, 'watch');
    const files = discoverSessionFiles(parentDir, { excludePatterns: ['vercel-plugin'] });
    assert.ok(!files.some(f => f.endsWith(path.join('vercel-plugin', 'skill-injections.jsonl'))));
  });
});

describe('syncAllFiles', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let syncAllFiles: typeof import('../src/watcher/index.js').syncAllFiles;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    syncAllFiles = mod.syncAllFiles;
  });

  test('syncs all discovered files and returns stats', () => {
    const db = getDb();
    const parentDir = path.join(tempDir, 'watch');

    // Write fresh session files
    const syncDir = path.join(tempDir, 'watch', 'projects', '-Users-dev-Dev-syncproject');
    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(
      path.join(syncDir, 'sync-001.jsonl'),
      makeSession('sync-001'),
    );
    fs.writeFileSync(
      path.join(syncDir, 'sync-002.jsonl'),
      makeSession('sync-002'),
    );
    const nestedSyncDir = path.join(syncDir, 'nested', 'deeper');
    fs.mkdirSync(nestedSyncDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedSyncDir, 'sync-003.jsonl'),
      makeSession('sync-003'),
    );

    const stats = syncAllFiles(db, parentDir);
    assert.ok(stats.parsed >= 3, `expected >= 3 parsed, got ${stats.parsed}`);
    assert.ok(typeof stats.skipped === 'number');
    assert.ok(typeof stats.errors === 'number');
  });

  test('syncAllFiles excludes matching paths before syncing', () => {
    const db = getDb();
    const parentDir = path.join(tempDir, 'watch');
    const excludedPattern = 'exclude-syncall-test';
    const excludedDir = path.join(watchDir, excludedPattern);
    fs.mkdirSync(excludedDir, { recursive: true });
    fs.writeFileSync(path.join(excludedDir, 'skill-injections.jsonl'), '{}\n');

    const stats = syncAllFiles(db, parentDir, { excludePatterns: [excludedPattern] });
    const excludedRecord = db.prepare(
      'SELECT * FROM watched_files WHERE file_path = ?',
    ).get(path.join(excludedDir, 'skill-injections.jsonl'));

    assert.equal(excludedRecord, undefined);
    assert.ok(stats.total >= 0);
  });
});
