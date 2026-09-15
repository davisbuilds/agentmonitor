import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repairSummaryTimestamps } from '../src/db/repair-summary-timestamps.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, event_id TEXT, session_id TEXT,
      agent_type TEXT, source TEXT, client_timestamp TEXT, created_at TEXT);
    CREATE TABLE browsing_sessions (id TEXT PRIMARY KEY, agent TEXT, integration_mode TEXT,
      fidelity TEXT, file_path TEXT, started_at TEXT, ended_at TEXT, last_item_at TEXT, message_count INTEGER);
    CREATE TABLE session_turns (id INTEGER PRIMARY KEY, session_id TEXT, source_turn_id TEXT,
      started_at TEXT, ended_at TEXT);
    CREATE TABLE session_items (id INTEGER PRIMARY KEY, session_id TEXT, turn_id INTEGER,
      created_at TEXT, payload_json TEXT);
    INSERT INTO events VALUES (1,'e1','s','codex','otel',NULL,'2026-09-14 12:00:00');
    INSERT INTO browsing_sessions VALUES ('s','codex','codex-otel','summary',NULL,
      '2026-09-14 12:00:00','2026-09-14 12:00:00','2026-09-14 12:00:00',7);
    INSERT INTO session_turns VALUES (1,'s','e1','2026-09-14 12:00:00','2026-09-14 12:00:00');
    INSERT INTO session_items VALUES (1,'s',1,'2026-09-14 12:00:00','{"untouched":true}');
  `);
  return db;
}

test('preview is read-only; apply changes only proven timestamps and is replay-safe', () => {
  const db = fixture();
  try {
    const before = db.serialize();
    const preview = repairSummaryTimestamps(db);
    assert.equal(preview.changes, 6);
    assert.deepEqual(db.serialize(), before);
    assert.equal(repairSummaryTimestamps(db, preview.digest).applied, true);
    assert.equal(repairSummaryTimestamps(db).changes, 0);
    assert.deepEqual(db.prepare('SELECT started_at,message_count FROM browsing_sessions').get(),
      { started_at: '2026-09-14T12:00:00Z', message_count: 7 });
    assert.deepEqual(db.prepare('SELECT payload_json FROM session_items').get(), { payload_json: '{"untouched":true}' });
    assert.deepEqual(db.prepare('SELECT created_at FROM events').get(), { created_at: '2026-09-14 12:00:00' });
  } finally { db.close(); }
});

test('client time, transcript projections and missing event lineage are never repaired', () => {
  for (const sql of [
    "UPDATE events SET client_timestamp=created_at",
    "UPDATE browsing_sessions SET file_path='/fixture.jsonl'",
    "UPDATE browsing_sessions SET integration_mode='codex-jsonl'",
    "UPDATE session_turns SET source_turn_id='unrelated'",
  ]) {
    const db = fixture();
    try {
      assert.equal(repairSummaryTimestamps(db).changes, 6);
      db.exec(sql);
      assert.equal(repairSummaryTimestamps(db).changes, 0);
    } finally { db.close(); }
  }
});

test('stale preview refuses changes and SQL failure rolls the whole repair back', () => {
  const db = fixture();
  try {
    const preview = repairSummaryTimestamps(db);
    const before = db.serialize();
    assert.throws(() => repairSummaryTimestamps(db, 'wrong'), /changed/);
    assert.deepEqual(db.serialize(), before);
    db.exec("CREATE TRIGGER refuse_item BEFORE UPDATE ON session_items BEGIN SELECT RAISE(ABORT,'fixture refusal'); END;");
    const guarded = db.serialize();
    assert.throws(() => repairSummaryTimestamps(db, preview.digest), /fixture refusal/);
    assert.deepEqual(db.serialize(), guarded);
  } finally { db.close(); }
});

test('operator script defaults to read-only and requires the matching digest to apply', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-time-repair-'));
  const filename = path.join(directory, 'fixture.db');
  const seed = fixture();
  fs.writeFileSync(filename, seed.serialize());
  seed.close();
  const run = (...args: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/repair-summary-timestamps.ts', '--db', filename, ...args],
    { encoding: 'utf8', timeout: 10_000 });
  try {
    const before = fs.readFileSync(filename);
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(fs.readFileSync(filename), before);
    const report = JSON.parse(preview.stdout) as { digest: string; changes: number };
    assert.equal(report.changes, 6);
    assert.equal(run('--apply').status, 1);
    assert.equal(run('--apply', '--expect-digest', '0'.repeat(64)).status, 1);
    assert.deepEqual(fs.readFileSync(filename), before);
    const applied = run('--apply', '--expect-digest', report.digest);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(run().stdout).changes, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
