// WHY: FTS5 cannot compare this index directly against its source view. Build a comparison index from
// the view.
import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';

export function assertSearchIndexMatchesMessages(db: Database): void {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
  db.exec(`
    DROP TABLE IF EXISTS temp.expected_search;
    DROP TABLE IF EXISTS temp.expected_terms;
    DROP TABLE IF EXISTS temp.actual_terms;
    CREATE VIRTUAL TABLE temp.expected_search USING fts5(content, tokenize='porter unicode61');
    INSERT INTO temp.expected_search(rowid, content) SELECT id, content FROM messages_search;
    CREATE VIRTUAL TABLE temp.expected_terms USING fts5vocab(temp, expected_search, instance);
    CREATE VIRTUAL TABLE temp.actual_terms USING fts5vocab(main, messages_fts, instance);
  `);
  const diff = (from: string, minus: string) => db.prepare(`
    SELECT term, doc, offset FROM ${from} EXCEPT SELECT term, doc, offset FROM ${minus} LIMIT 5
  `).all();
  try {
    assert.deepEqual(diff('temp.actual_terms', 'temp.expected_terms'), [], 'the index holds entries the messages do not');
    assert.deepEqual(diff('temp.expected_terms', 'temp.actual_terms'), [], 'the index is missing entries the messages have');
  } finally {
    db.exec('DROP TABLE temp.actual_terms; DROP TABLE temp.expected_terms; DROP TABLE temp.expected_search;');
  }
}
