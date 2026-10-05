import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { stripInlineImages } from '../src/util/inline-images.js';

const bytes = Buffer.alloc(3000, 7);
const data = bytes.toString('base64');
const sha = createHash('sha256').update(bytes).digest('hex');
const descriptor = `omitted-image;sha256=${sha};bytes=${bytes.length}`;

test('an image block keeps its type and media type but not its data', () => {
  const json = JSON.stringify([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
  const out = stripInlineImages(json);
  assert.deepEqual(JSON.parse(out), [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: descriptor } }]);
});

test('data before the media type, and images inside JSON-escaped strings, are stripped too', () => {
  const block = { type: 'image', source: { type: 'base64', data, media_type: 'image/jpeg' } };
  const escaped = JSON.stringify([{ type: 'tool_result', content: JSON.stringify([block]) }]);
  const out = stripInlineImages(escaped);
  assert.ok(!out.includes(data.slice(0, 200)));
  const inner = JSON.parse(JSON.parse(out)[0].content);
  assert.deepEqual(inner, [{ type: 'image', source: { type: 'base64', data: descriptor, media_type: 'image/jpeg' } }]);
});

test('a base64 source that is not an image keeps its data', () => {
  const pdf = JSON.stringify([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }]);
  assert.equal(stripInlineImages(pdf), pdf);
});

test('an image source is found whatever its property order', () => {
  const reordered = JSON.stringify([{ type: 'image', source: { data, cache: 'x', type: 'base64', media_type: 'image/webp' } }]);
  assert.deepEqual(JSON.parse(stripInlineImages(reordered)),
    [{ type: 'image', source: { data: descriptor, cache: 'x', type: 'base64', media_type: 'image/webp' } }]);
  const noMediaType = JSON.stringify([{ type: 'image', source: { type: 'base64', data } }]);
  assert.deepEqual(JSON.parse(stripInlineImages(noMediaType)), [{ type: 'image', source: { type: 'base64', data: descriptor } }],
    'an image block vouches for a source without a media type');
});

test('an image in serialized JSON that no longer parses is still stripped', () => {
  // A truncated or prose-embedded serialization: the structure is gone, the
  // escaped image source is not.
  const block = JSON.stringify({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  const pdfBlock = JSON.stringify({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
  const out = stripInlineImages(JSON.stringify({ text: `see [${block}, ${pdfBlock}` }));
  const text = JSON.parse(out).text as string;
  assert.ok(text.includes(descriptor));
  assert.ok(text.includes(`"media_type":"application/pdf","data":"${data}"`), 'non-image data stays');
});

test('a data URI image is stripped in place', () => {
  const out = stripInlineImages(JSON.stringify({ text: `[image1]: <data:image/png;base64,${data}>` }));
  assert.equal(JSON.parse(out).text, `[image1]: <data:image/png;${descriptor}>`);
});

test('other long strings and short images are left alone, and stripping is idempotent', () => {
  const unrelated = JSON.stringify({ type: 'file', encoding: 'base64', data });
  assert.equal(stripInlineImages(unrelated), unrelated, 'only base64 image sources are stripped');
  const tiny = JSON.stringify({ type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(stripInlineImages(tiny), tiny);
  const once = stripInlineImages(JSON.stringify([{ type: 'base64', media_type: 'image/png', data }]));
  assert.equal(stripInlineImages(once), once);
});

const { default: Database } = await import('better-sqlite3');
const { parseSessionMessages } = await import('../src/parser/claude-code.js');
const { insertProjectedItem } = await import('../src/live/projector.js');
const { runDataMigrations } = await import('../src/db/schema.js');

const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };

test('the Claude parser stores pasted and tool-result images as descriptors', () => {
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-05T10:00:05Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [imageBlock] },
    ] } },
  ];
  const parsed = parseSessionMessages(lines.map(line => JSON.stringify(line)).join('\n'), 's-img', '/tmp/s-img.jsonl');
  assert.equal(parsed.messages.length, 2);
  for (const message of parsed.messages) {
    assert.ok(!message.content.includes(data.slice(0, 200)), 'no image data is stored');
    assert.ok(message.content.includes(descriptor));
    assert.equal(message.content_length, message.content.length);
  }
});

test('projected session items store images as descriptors', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE session_items (id INTEGER PRIMARY KEY, session_id TEXT, turn_id INTEGER, ordinal INTEGER,
    source_item_id TEXT, kind TEXT, status TEXT, payload_json TEXT, created_at TEXT)`);
  insertProjectedItem(db, 's-img', null, { ordinal: 0, kind: 'tool_result', payload: { content: [imageBlock] } });
  const stored = (db.prepare('SELECT payload_json FROM session_items').get() as { payload_json: string }).payload_json;
  assert.deepEqual(JSON.parse(stored), { content: [{ ...imageBlock, source: { ...imageBlock.source, data: descriptor } }] });
});

test('v16 strips images already stored, and the search index forgets them', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, content_length INTEGER NOT NULL DEFAULT 0);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=id, tokenize='porter unicode61');
    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TABLE session_items (id INTEGER PRIMARY KEY, session_id TEXT, payload_json TEXT);
  `);
  const withImage = JSON.stringify([{ type: 'text', text: 'screenshot attached' }, imageBlock]);
  const plain = JSON.stringify([{ type: 'text', text: 'no base64 here' }]);
  const insert = db.prepare('INSERT INTO messages (session_id, ordinal, role, content, content_length) VALUES (?, ?, ?, ?, ?)');
  insert.run('s', 0, 'user', withImage, withImage.length);
  insert.run('s', 1, 'user', plain, plain.length);
  db.prepare('INSERT INTO session_items (session_id, payload_json) VALUES (?, ?)').run('s', JSON.stringify({ content: [imageBlock] }));
  const imageToken = `${data.slice(0, 40).toLowerCase()}*`;
  const hits = (query: string) => (db.prepare('SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH ?').get(query) as { c: number }).c;
  assert.equal(hits(imageToken), 1, 'control: the image data is indexed before the migration');

  db.pragma('user_version = 15');
  runDataMigrations(db);

  const rows = db.prepare('SELECT content, content_length FROM messages ORDER BY ordinal').all() as Array<{ content: string; content_length: number }>;
  assert.equal(rows[0].content, stripInlineImages(withImage));
  assert.equal(rows[0].content_length, rows[0].content.length);
  assert.equal(rows[1].content, plain);
  const item = (db.prepare('SELECT payload_json FROM session_items').get() as { payload_json: string }).payload_json;
  assert.ok(!item.includes(data.slice(0, 200)));
  assert.equal(hits(imageToken), 0, 'the index no longer holds the image data');
  assert.equal(hits('screenshot'), 1, 'the message text is still searchable');
  assert.equal(db.pragma('user_version', { simple: true }), 16);
});
