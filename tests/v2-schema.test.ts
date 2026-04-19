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
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-schema-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const schemaModule = await import('../src/db/schema.js');
  initSchema = schemaModule.initSchema;

  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// --- browsing_sessions table ---

test('browsing_sessions table exists with correct columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(browsing_sessions)").all() as Array<{ name: string; type: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('id'), 'should have id column');
  assert.ok(colNames.includes('project'), 'should have project column');
  assert.ok(colNames.includes('agent'), 'should have agent column');
  assert.ok(colNames.includes('first_message'), 'should have first_message column');
  assert.ok(colNames.includes('started_at'), 'should have started_at column');
  assert.ok(colNames.includes('ended_at'), 'should have ended_at column');
  assert.ok(colNames.includes('message_count'), 'should have message_count column');
  assert.ok(colNames.includes('user_message_count'), 'should have user_message_count column');
  assert.ok(colNames.includes('parent_session_id'), 'should have parent_session_id column');
  assert.ok(colNames.includes('relationship_type'), 'should have relationship_type column');
  assert.ok(colNames.includes('file_path'), 'should have file_path column');
  assert.ok(colNames.includes('file_size'), 'should have file_size column');
  assert.ok(colNames.includes('file_hash'), 'should have file_hash column');
});

test('browsing_sessions insert and query', () => {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (id, project, agent, first_message, started_at, ended_at, message_count, user_message_count, file_path, file_size, file_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess-001', 'my-project', 'claude', 'Hello world', '2026-03-06T10:00:00Z', '2026-03-06T11:00:00Z', 42, 20, '/path/to/file.jsonl', 1024, 'abc123');

  const row = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get('sess-001') as Record<string, unknown>;
  assert.equal(row.project, 'my-project');
  assert.equal(row.agent, 'claude');
  assert.equal(row.message_count, 42);
  assert.equal(row.file_hash, 'abc123');
});

test('browsing_sessions indexes exist', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='browsing_sessions'").all() as Array<{ name: string }>;
  const indexNames = indexes.map(i => i.name);

  assert.ok(indexNames.some(n => n.includes('ended_at')), 'should have ended_at index');
  assert.ok(indexNames.some(n => n.includes('project')), 'should have project index');
  assert.ok(indexNames.some(n => n.includes('agent')), 'should have agent index');
  assert.ok(indexNames.some(n => n.includes('started_at')), 'should have started_at index');
});

// --- messages table ---

test('messages table exists with correct columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('id'), 'should have id column');
  assert.ok(colNames.includes('session_id'), 'should have session_id column');
  assert.ok(colNames.includes('ordinal'), 'should have ordinal column');
  assert.ok(colNames.includes('role'), 'should have role column');
  assert.ok(colNames.includes('content'), 'should have content column');
  assert.ok(colNames.includes('timestamp'), 'should have timestamp column');
  assert.ok(colNames.includes('has_thinking'), 'should have has_thinking column');
  assert.ok(colNames.includes('has_tool_use'), 'should have has_tool_use column');
  assert.ok(colNames.includes('content_length'), 'should have content_length column');
});

test('messages insert and query', () => {
  const db = getDb();
  const content = JSON.stringify([{ type: 'text', text: 'Hello, how can I help?' }]);
  db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess-001', 1, 'assistant', content, '2026-03-06T10:00:01Z', 0, 0, content.length);

  const row = db.prepare('SELECT * FROM messages WHERE session_id = ? AND ordinal = ?').get('sess-001', 1) as Record<string, unknown>;
  assert.equal(row.role, 'assistant');
  assert.equal(row.session_id, 'sess-001');
  const parsed = JSON.parse(row.content as string);
  assert.equal(parsed[0].type, 'text');
});

test('messages indexes exist', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'").all() as Array<{ name: string }>;
  const indexNames = indexes.map(i => i.name);

  assert.ok(indexNames.some(n => n.includes('session_ordinal')), 'should have session_id+ordinal compound index');
  assert.ok(indexNames.some(n => n.includes('session_role')), 'should have session_id+role compound index');
});

// --- pinned_messages table ---

test('pinned_messages table exists with correct columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(pinned_messages)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('id'), 'should have id column');
  assert.ok(colNames.includes('session_id'), 'should have session_id column');
  assert.ok(colNames.includes('message_id'), 'should have message_id column');
  assert.ok(colNames.includes('message_ordinal'), 'should have message_ordinal column');
  assert.ok(colNames.includes('created_at'), 'should have created_at column');
});

test('pinned_messages enforce one pin per session ordinal', () => {
  const db = getDb();
  db.prepare(`
    INSERT INTO pinned_messages (session_id, message_id, message_ordinal)
    VALUES (?, ?, ?)
  `).run('sess-pinned', 101, 2);

  assert.throws(() => {
    db.prepare(`
      INSERT INTO pinned_messages (session_id, message_id, message_ordinal)
      VALUES (?, ?, ?)
    `).run('sess-pinned', 202, 2);
  });
});

test('pinned_messages indexes exist', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pinned_messages'").all() as Array<{ name: string }>;
  const indexNames = indexes.map(i => i.name);

  assert.ok(indexNames.some(n => n.includes('session_ordinal')), 'should have session/ordinal index');
  assert.ok(indexNames.some(n => n.includes('created_at')), 'should have created_at index');
});

// --- insights table ---

test('insights table exists with correct columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(insights)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('id'), 'should have id column');
  assert.ok(colNames.includes('kind'), 'should have kind column');
  assert.ok(colNames.includes('title'), 'should have title column');
  assert.ok(colNames.includes('prompt'), 'should have prompt column');
  assert.ok(colNames.includes('content'), 'should have content column');
  assert.ok(colNames.includes('date_from'), 'should have date_from column');
  assert.ok(colNames.includes('date_to'), 'should have date_to column');
  assert.ok(colNames.includes('project'), 'should have project column');
  assert.ok(colNames.includes('agent'), 'should have agent column');
  assert.ok(colNames.includes('provider'), 'should have provider column');
  assert.ok(colNames.includes('model'), 'should have model column');
  assert.ok(colNames.includes('analytics_summary_json'), 'should have analytics_summary_json column');
  assert.ok(colNames.includes('analytics_coverage_json'), 'should have analytics_coverage_json column');
  assert.ok(colNames.includes('usage_summary_json'), 'should have usage_summary_json column');
  assert.ok(colNames.includes('usage_coverage_json'), 'should have usage_coverage_json column');
  assert.ok(colNames.includes('input_json'), 'should have input_json column');
  assert.ok(colNames.includes('created_at'), 'should have created_at column');
});

test('insights insert and query', () => {
  const db = getDb();
  db.prepare(`
    INSERT INTO insights (
      kind, title, prompt, content, date_from, date_to, project, agent, provider, model,
      analytics_summary_json, analytics_coverage_json, usage_summary_json, usage_coverage_json, input_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'overview',
    'Weekly Insight',
    'Focus on delivery.',
    '# Weekly Insight\n\nContent',
    '2026-03-01',
    '2026-03-07',
    'alpha',
    'claude',
    'openai',
    'gpt-5-mini',
    JSON.stringify({ total_sessions: 1 }),
    JSON.stringify({ matching_sessions: 1 }),
    JSON.stringify({ total_cost_usd: 1.23 }),
    JSON.stringify({ matching_events: 2 }),
    JSON.stringify({ analytics_activity: [] }),
  );

  const row = db.prepare('SELECT * FROM insights WHERE title = ?').get('Weekly Insight') as Record<string, unknown>;
  assert.equal(row.kind, 'overview');
  assert.equal(row.project, 'alpha');
  assert.equal(row.model, 'gpt-5-mini');
});

test('insights indexes exist', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='insights'").all() as Array<{ name: string }>;
  const indexNames = indexes.map(i => i.name);

  assert.ok(indexNames.some(n => n.includes('created_at')), 'should have created_at index');
  assert.ok(indexNames.some(n => n.includes('scope')), 'should have scope index');
});

// --- tool_calls table ---

test('tool_calls table exists with correct columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('id'), 'should have id column');
  assert.ok(colNames.includes('message_id'), 'should have message_id column');
  assert.ok(colNames.includes('session_id'), 'should have session_id column');
  assert.ok(colNames.includes('tool_name'), 'should have tool_name column');
  assert.ok(colNames.includes('category'), 'should have category column');
  assert.ok(colNames.includes('tool_use_id'), 'should have tool_use_id column');
  assert.ok(colNames.includes('input_json'), 'should have input_json column');
  assert.ok(colNames.includes('result_content'), 'should have result_content column');
  assert.ok(colNames.includes('result_content_length'), 'should have result_content_length column');
  assert.ok(colNames.includes('subagent_session_id'), 'should have subagent_session_id column');
});

test('tool_calls insert and query', () => {
  const db = getDb();
  // First insert a message to get a valid message_id
  const msgResult = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess-001', 2, 'assistant', '[]', '2026-03-06T10:00:02Z', 0, 1, 2);

  db.prepare(`
    INSERT INTO tool_calls (message_id, session_id, tool_name, category, tool_use_id, input_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msgResult.lastInsertRowid, 'sess-001', 'Read', 'Read', 'tu_123', '{"file_path":"/foo.ts"}');

  const row = db.prepare('SELECT * FROM tool_calls WHERE session_id = ? AND tool_name = ?').get('sess-001', 'Read') as Record<string, unknown>;
  assert.equal(row.category, 'Read');
  assert.equal(row.tool_use_id, 'tu_123');
});

test('tool_calls indexes exist', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_calls'").all() as Array<{ name: string }>;
  const indexNames = indexes.map(i => i.name);

  assert.ok(indexNames.some(n => n.includes('session_id')), 'should have session_id index');
  assert.ok(indexNames.some(n => n.includes('category')), 'should have category index');
  assert.ok(indexNames.some(n => n.includes('tool_name')), 'should have tool_name index');
});

// --- FTS5 ---

test('messages_fts virtual table exists', () => {
  const db = getDb();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get() as { name: string } | undefined;
  assert.ok(table, 'messages_fts table should exist');
});

test('FTS5 search returns matching results on insert', () => {
  const db = getDb();
  // Insert a message with searchable content
  const content = JSON.stringify([{ type: 'text', text: 'Implementing a recursive fibonacci function in TypeScript' }]);
  db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess-002', 1, 'user', content, '2026-03-06T12:00:00Z', 0, 0, content.length);

  // FTS5 search should find it
  const results = db.prepare(`
    SELECT messages.id, messages.session_id, messages.content
    FROM messages_fts
    JOIN messages ON messages.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
  `).all('fibonacci') as Array<{ id: number; session_id: string; content: string }>;

  assert.ok(results.length > 0, 'FTS search for "fibonacci" should return results');
  assert.equal(results[0].session_id, 'sess-002');
});

test('FTS5 snippet extraction works', () => {
  const db = getDb();
  const results = db.prepare(`
    SELECT snippet(messages_fts, 0, '<b>', '</b>', '...', 10) as snippet
    FROM messages_fts
    WHERE messages_fts MATCH ?
  `).all('fibonacci') as Array<{ snippet: string }>;

  assert.ok(results.length > 0, 'should return snippet results');
  assert.ok(results[0].snippet.includes('fibonacci'), 'snippet should contain the search term');
});

test('FTS5 stays in sync on DELETE', () => {
  const db = getDb();
  // Insert then delete a message
  const content = JSON.stringify([{ type: 'text', text: 'unique_deleteme_term_xyz' }]);
  const result = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess-003', 1, 'user', content, '2026-03-06T13:00:00Z', 0, 0, content.length);

  // Verify it's searchable
  let ftsResults = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all('unique_deleteme_term_xyz');
  assert.ok(ftsResults.length > 0, 'should be searchable before delete');

  // Delete the message
  db.prepare('DELETE FROM messages WHERE id = ?').run(result.lastInsertRowid);

  // Should no longer be in FTS
  ftsResults = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all('unique_deleteme_term_xyz');
  assert.equal(ftsResults.length, 0, 'should not be searchable after delete');
});

test('FTS5 stays in sync on UPDATE', () => {
  const db = getDb();
  const content1 = JSON.stringify([{ type: 'text', text: 'original_unique_updatetest_content' }]);
  const result = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess-004', 1, 'user', content1, '2026-03-06T14:00:00Z', 0, 0, content1.length);

  const content2 = JSON.stringify([{ type: 'text', text: 'replaced_unique_updatetest_content' }]);
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content2, result.lastInsertRowid);

  // Old content should not be found
  let ftsResults = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all('original_unique_updatetest_content');
  assert.equal(ftsResults.length, 0, 'old content should not be searchable');

  // New content should be found
  ftsResults = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all('replaced_unique_updatetest_content');
  assert.ok(ftsResults.length > 0, 'new content should be searchable');
});

// --- watched_files table ---

test('watched_files table exists with correct columns', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(watched_files)").all() as Array<{ name: string }>;
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('file_path'), 'should have file_path column');
  assert.ok(colNames.includes('file_hash'), 'should have file_hash column');
  assert.ok(colNames.includes('file_mtime'), 'should have file_mtime column');
  assert.ok(colNames.includes('status'), 'should have status column');
  assert.ok(colNames.includes('last_parsed_at'), 'should have last_parsed_at column');
});

test('watched_files dedup: skip unchanged hash', () => {
  const db = getDb();
  db.prepare(`
    INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run('/path/to/session.jsonl', 'hash_aaa', '2026-03-06T10:00:00Z', 'parsed');

  // Same hash should indicate no re-parse needed
  const existing = db.prepare('SELECT file_hash FROM watched_files WHERE file_path = ?').get('/path/to/session.jsonl') as { file_hash: string } | undefined;
  assert.ok(existing, 'should find existing record');
  assert.equal(existing.file_hash, 'hash_aaa');

  // Simulate changed file: different hash means re-parse needed
  const needsReparse = existing.file_hash !== 'hash_bbb';
  assert.ok(needsReparse, 'different hash should trigger re-parse');

  // Same hash means skip
  const shouldSkip = existing.file_hash === 'hash_aaa';
  assert.ok(shouldSkip, 'same hash should skip');
});

// --- Backward compatibility ---

test('existing tables are unmodified', () => {
  const db = getDb();

  // Verify existing tables still exist
  for (const tableName of ['agents', 'sessions', 'events', 'import_state']) {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
    assert.ok(table, `${tableName} table should still exist`);
  }

  // Verify existing events columns are intact
  const eventColumns = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const eventColNames = eventColumns.map(c => c.name);
  for (const col of ['id', 'session_id', 'agent_type', 'event_type', 'tokens_in', 'tokens_out', 'cost_usd', 'model']) {
    assert.ok(eventColNames.includes(col), `events table should still have ${col} column`);
  }
});
