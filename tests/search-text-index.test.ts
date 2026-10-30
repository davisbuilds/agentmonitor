import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';
import { assertSearchIndexMatchesMessages } from './helpers/search-index.js';

/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let searchMessages: typeof import('../src/db/v2-queries.js').searchMessages;
/* eslint-enable @typescript-eslint/consistent-type-imports */

let tempDir = '';
let dbPath = '';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-search-text-'));
  dbPath = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  ({ initSchema } = await import('../src/db/schema.js'));
  ({ searchMessages } = await import('../src/db/v2-queries.js'));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Messages stored the way the parsers store them: JSON content blocks. */
const MESSAGES = [
  [{ type: 'text', text: 'Refactor the fibonacci helper' }],
  [{ type: 'thinking', text: 'The memoized variant avoids recomputation' }],
  [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'pnpm vitest run', description: 'Run unit tests' } }],
  [{ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'All suites passed' }] }],
  [{ type: 'text', text: 'Which type annotation fits here?' }],
  [{ type: 'tool_use', id: 'toolu_02', name: 'Task', input: { type: 'explorer', id: 'sentinel-ticket', nested: [{ type: 'quorum' }] } }],
];

function insertMessages(db: Database.Database, sessionId: string): void {
  db.prepare(`INSERT INTO browsing_sessions (id, agent, project, started_at, message_count) VALUES (?, 'claude', 'demo', ?, ?)`)
    .run(sessionId, '2026-10-16T09:00:00Z', MESSAGES.length);
  const insert = db.prepare(`INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, 'assistant', ?, '2026-10-16T09:00:00Z', 0, 0, ?)`);
  MESSAGES.forEach((blocks, ordinal) => {
    const content = JSON.stringify(blocks);
    insert.run(sessionId, ordinal, content, content.length);
  });
}

const ordinals = (q: string) => searchMessages({ q, limit: 50 }).data.map(row => row.message_ordinal).sort();

test('search matches the words a message says, not the keys of its stored JSON', () => {
  initSchema();
  insertMessages(getDb(), 'search-s1');

  assert.deepEqual(ordinals('fibonacci'), [0], 'control: message text is searchable');
  assert.deepEqual(ordinals('memoized'), [1], 'thinking text is searchable');
  assert.deepEqual(ordinals('vitest'), [2], 'tool input values are searchable');
  assert.deepEqual(ordinals('Bash'), [2], 'tool names are searchable');
  assert.deepEqual(ordinals('suites'), [3], 'tool result text is searchable');
  assert.deepEqual(ordinals('type'), [4], 'the block key "type" matches only a message that says it');
  assert.deepEqual(ordinals('text'), [], 'the block key "text" matches nothing');
  assert.deepEqual(ordinals('toolu_01'), [], 'tool ids are not indexed');
  assert.deepEqual(ordinals('explorer'), [5], 'a tool input field named "type" is searchable');
  assert.deepEqual(ordinals('sentinel'), [5], 'a tool input field named "id" is searchable');
  assert.deepEqual(ordinals('quorum'), [5], 'nested tool input values are searchable');
});

test('snippets show the message text without JSON syntax', () => {
  const [hit] = searchMessages({ q: 'fibonacci', limit: 5 }).data;
  assert.equal(hit.snippet, 'Refactor the <mark>fibonacci</mark> helper');
  const [tool] = searchMessages({ q: 'vitest', limit: 5 }).data;
  assert.doesNotMatch(tool.snippet, /[{}"]|command/);
});

test('the index follows edits and deletes, and passes its integrity check', () => {
  const db = getDb();
  const replaced = JSON.stringify([{ type: 'text', text: 'Refactor the lucas helper' }]);
  db.prepare("UPDATE messages SET content = ? WHERE session_id = 'search-s1' AND ordinal = 0").run(replaced);
  assert.deepEqual(ordinals('fibonacci'), []);
  assert.deepEqual(ordinals('lucas'), [0]);
  db.prepare("DELETE FROM messages WHERE session_id = 'search-s1' AND ordinal = 1").run();
  assert.deepEqual(ordinals('memoized'), []);
  assertSearchIndexMatchesMessages(db);
});

test('a database indexed the old way is reindexed on upgrade', () => {
  // The schema as it was at data version 20: the index read the raw JSON.
  const db = getDb();
  db.exec(`
    DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update;
    DROP TABLE messages_fts; DROP VIEW messages_search;
    DELETE FROM messages; DELETE FROM browsing_sessions;
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=id, tokenize='porter unicode61');
    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  db.pragma('user_version = 20');
  insertMessages(db, 'search-legacy');
  const keyHits = (db.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'text'").get() as { c: number }).c;
  assert.equal(keyHits, 4, 'control: the old index matches the "text" key');

  initSchema();
  assert.equal(db.pragma('user_version', { simple: true }), 25);
  assert.deepEqual(ordinals('text'), []);
  assert.deepEqual(ordinals('fibonacci'), [0]);
  assertSearchIndexMatchesMessages(db);
});

test('an index whose view extracts text by an earlier rule is rebuilt', () => {
  const db = getDb();
  // The first v21 rule skipped bookkeeping keys at any depth, tool inputs included.
  db.exec(`DROP VIEW messages_search;
    CREATE VIEW messages_search AS SELECT id, content AS content FROM messages`);
  initSchema();
  const view = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_search'").get() as { sql: string };
  assert.match(view.sql, /json_tree/);
  assert.deepEqual(ordinals('explorer'), [5]);
  assertSearchIndexMatchesMessages(db);
});
