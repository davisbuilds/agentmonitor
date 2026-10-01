import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type {
  insertParsedSession as insertParsedSessionFn,
  parseSessionMessages as parseSessionMessagesFn,
  ParsedSession,
} from '../src/parser/claude-code.js';

let tempDir = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let insertParsedSession: typeof insertParsedSessionFn;
let parseSessionMessages: typeof parseSessionMessagesFn;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-incremental-sync-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  ({ insertParsedSession, parseSessionMessages } = await import('../src/parser/claude-code.js'));
  assert.equal(getDb().name, path.join(tempDir, 'test.db'));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const FILE = '/Users/dev/.claude/projects/-Users-dev-Dev-proj/session.jsonl';

function userLine(text: string, second: number): object {
  return {
    type: 'user',
    cwd: '/Users/dev/Dev/proj',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`,
  };
}

function toolLine(id: string, command: string, second: number): object {
  return {
    type: 'assistant',
    cwd: '/Users/dev/Dev/proj',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
    timestamp: `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`,
  };
}

function parse(sessionId: string, lines: object[]): ParsedSession {
  return parseSessionMessages(lines.map(line => JSON.stringify(line)).join('\n') + '\n', sessionId, FILE);
}

function store(parsed: ParsedSession): void {
  insertParsedSession(getDb(), parsed, FILE, 1, 'hash');
}

interface MessageRow { id: number; ordinal: number; content: string }
interface ToolRow { id: number; ordinal: number; tool_use_id: string; category: string; input_json: string }

function messageRows(sessionId: string): MessageRow[] {
  return getDb().prepare(
    'SELECT id, ordinal, content FROM messages WHERE session_id = ? ORDER BY ordinal',
  ).all(sessionId) as MessageRow[];
}

function toolRows(sessionId: string): ToolRow[] {
  return getDb().prepare(`
    SELECT tc.id, m.ordinal, tc.tool_use_id, tc.category, tc.input_json
    FROM tool_calls tc JOIN messages m ON m.id = tc.message_id
    WHERE tc.session_id = ? ORDER BY tc.id
  `).all(sessionId) as ToolRow[];
}

function toolCallCount(sessionId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?')
    .get(sessionId) as { n: number }).n;
}

/** The browser projection minus row ids: what a full rewrite would store. */
function projection(sessionId: string): unknown {
  const db = getDb();
  return {
    messages: db.prepare(`
      SELECT ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length
      FROM messages WHERE session_id = ? ORDER BY ordinal
    `).all(sessionId),
    toolCalls: db.prepare(`
      SELECT m.ordinal, tc.tool_name, tc.category, tc.tool_use_id, tc.input_json, tc.subagent_session_id
      FROM tool_calls tc JOIN messages m ON m.id = tc.message_id
      WHERE tc.session_id = ? ORDER BY m.ordinal, tc.id
    `).all(sessionId),
  };
}

function searchHits(sessionId: string, term: string): number {
  return (getDb().prepare(`
    SELECT COUNT(*) AS n FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    WHERE messages_fts MATCH ? AND m.session_id = ?
  `).get(term, sessionId) as { n: number }).n;
}

function assertSearchIndexMatchesMessages(): void {
  // For an external-content FTS5 table, rank 1 also checks the index against
  // the content table, so a stale or missing row raises here.
  getDb().prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)").run();
}

const BASE = [
  userLine('alpha request', 0),
  toolLine('t1', 'ls bravo', 1),
  userLine('charlie followup', 2),
];

describe('insertParsedSession re-sync', () => {
  test('appending lines keeps stored rows and inserts only the new ones', () => {
    store(parse('append', BASE));
    const before = messageRows('append');
    const toolsBefore = toolRows('append');

    store(parse('append', [...BASE, toolLine('t2', 'cat delta', 3), userLine('echo done', 4)]));
    const after = messageRows('append');

    assert.equal(after.length, 5);
    assert.deepEqual(after.slice(0, 3).map(row => row.id), before.map(row => row.id));
    assert.ok(after[3].id > before[2].id && after[4].id > after[3].id);
    const toolsAfter = toolRows('append');
    assert.deepEqual(toolsAfter.map(row => row.tool_use_id), ['t1', 't2']);
    assert.equal(toolCallCount('append'), 2);
    assert.equal(toolsAfter[0].id, toolsBefore[0].id);
    assert.equal(toolsAfter[1].ordinal, 3);
    assert.equal(searchHits('append', 'delta'), 1);
    assertSearchIndexMatchesMessages();
  });

  test('a rewritten earlier line replaces rows from the first change onward', () => {
    store(parse('rewrite', [...BASE, userLine('foxtrot tail', 3)]));
    const before = messageRows('rewrite');

    // Same length as "ls bravo", so a length-only comparison would miss it.
    const rewritten = [BASE[0], toolLine('t1', 'ls hotel', 1), BASE[2], userLine('foxtrot tail', 3)];
    store(parse('rewrite', rewritten));
    const after = messageRows('rewrite');

    assert.equal(after[0].id, before[0].id);
    assert.notEqual(after[1].id, before[1].id);
    assert.match(after[1].content, /ls hotel/);
    assert.equal(toolRows('rewrite')[0].input_json, JSON.stringify({ command: 'ls hotel' }));
    assert.equal(searchHits('rewrite', 'bravo'), 0);
    assert.equal(searchHits('rewrite', 'hotel'), 1);
    assertSearchIndexMatchesMessages();

    // The stored rows are what a full rewrite of the new parse would store.
    const expected = parse('rewrite-fresh', rewritten);
    store(expected);
    assert.deepEqual(
      JSON.stringify(projection('rewrite')),
      JSON.stringify(projection('rewrite-fresh')).replaceAll('rewrite-fresh', 'rewrite'),
    );
  });

  test('a same-length edit to a text message is detected', () => {
    store(parse('sameLength', BASE));
    const before = messageRows('sameLength');

    store(parse('sameLength', [BASE[0], BASE[1], userLine('charlie fallowup', 2)]));
    const after = messageRows('sameLength');

    assert.deepEqual(after.slice(0, 2).map(row => row.id), before.slice(0, 2).map(row => row.id));
    assert.match(after[2].content, /charlie fallowup/);
    assertSearchIndexMatchesMessages();
  });

  test('a shortened transcript drops the messages it no longer contains', () => {
    store(parse('shrink', [...BASE, userLine('golf removed', 3)]));
    const before = messageRows('shrink');

    store(parse('shrink', BASE.slice(0, 1)));
    const after = messageRows('shrink');

    assert.deepEqual(after.map(row => row.id), [before[0].id]);
    assert.equal(toolCallCount('shrink'), 0);
    assert.equal(searchHits('shrink', 'golf'), 0);
    assertSearchIndexMatchesMessages();
  });

  test('a changed tool call on an unchanged message is rewritten', () => {
    store(parse('toolchange', BASE));
    const parsed = parse('toolchange', BASE);
    parsed.toolCalls[0].category = 'Recategorized';
    store(parsed);

    assert.deepEqual(toolRows('toolchange').map(row => row.category), ['Recategorized']);
  });

  test('stored rows that do not form one ordinal sequence are rewritten in full', () => {
    store(parse('stray', BASE));
    getDb().prepare(`
      INSERT INTO messages (session_id, ordinal, role, content, timestamp)
      VALUES ('stray', 1, 'user', '[]', NULL)
    `).run();

    store(parse('stray', BASE));

    assert.deepEqual(messageRows('stray').map(row => row.ordinal), [0, 1, 2]);
    assertSearchIndexMatchesMessages();
  });

  test('a tool call whose message is gone is cleared without rewriting history', () => {
    store(parse('orphan', BASE));
    const before = messageRows('orphan');
    getDb().prepare(`
      INSERT INTO tool_calls (id, message_id, session_id, tool_name, category)
      VALUES (-1, -1, 'orphan', 'Bash', 'Bash')
    `).run();

    store(parse('orphan', BASE));

    assert.equal(toolCallCount('orphan'), 1);
    assert.deepEqual(messageRows('orphan').map(row => row.id), before.map(row => row.id));
    assert.deepEqual(toolRows('orphan').map(row => row.tool_use_id), ['t1']);
  });
});
