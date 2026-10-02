import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { auditIndexes, explain, indexesInPlan, regressions, replicateSchema } from '../scripts/verify/index-audit.js';
import { reviveParams, serializeParams } from '../scripts/verify/record-sql.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ev (id INTEGER PRIMARY KEY, agent TEXT, kind TEXT, created TEXT, study TEXT, model TEXT);
    CREATE INDEX idx_agent ON ev(agent);
    CREATE INDEX idx_agent_kind ON ev(agent, kind);
    CREATE INDEX idx_study ON ev(study);
    CREATE INDEX idx_unused ON ev(created);
    CREATE UNIQUE INDEX idx_unique ON ev(kind, created);
    CREATE INDEX idx_m1 ON ev(model);
    CREATE INDEX idx_m2 ON ev(model);
    CREATE INDEX idx_kind ON ev(kind);
  `);
  return db;
}

const statements = [
  { sql: 'SELECT id FROM ev WHERE agent = ?', params: ['a'] },
  { sql: 'SELECT * FROM ev WHERE agent = ? AND kind = ?', params: ['a', 'k'] },
  { sql: 'SELECT * FROM ev WHERE study = ?', params: ['s'] },
  { sql: 'SELECT id FROM ev WHERE model = ?', params: null },
  { sql: 'SELECT id FROM ev WHERE kind = ?', params: ['k'] },
];

test('auditIndexes classifies each index and keeps one of two that only replace each other', () => {
  const db = fixture();
  const result = auditIndexes(db, 'ev', statements);
  const verdict = Object.fromEntries(result.verdicts.map(v => [v.name, v.verdict]));
  const { idx_m1, idx_m2, ...rest } = verdict;
  assert.deepEqual(rest, {
    idx_agent: 'replaceable',
    idx_agent_kind: 'needed',
    idx_kind: 'replaceable',
    idx_study: 'needed',
    idx_unique: 'constraint',
    idx_unused: 'unused',
  });
  // The planner always picks one of two identical indexes; the other is replaceable.
  assert.deepEqual([idx_m1, idx_m2].sort(), ['replaceable', 'unused']);
  const study = result.verdicts.find(v => v.name === 'idx_study')!;
  assert.ok(study.regressions[0].regressions.includes('full_scan'));
  const agentKind = result.verdicts.find(v => v.name === 'idx_agent_kind')!;
  assert.ok(agentKind.regressions[0].regressions.includes('fewer_index_terms'));
  assert.deepEqual(result.verdicts.find(v => v.name === 'idx_agent')!.replacements, ['idx_agent_kind']);

  // Either duplicate can go, but not both.
  const models = ['idx_m1', 'idx_m2'];
  assert.equal(result.drop_set.filter(name => models.includes(name)).length, 1);
  assert.deepEqual(result.kept_by_joint_check.map(entry => entry.name).filter(name => models.includes(name)).length, 1);
  assert.ok(result.drop_set.includes('idx_unused'));
  assert.ok(result.drop_set.includes('idx_agent'));
  assert.ok(!result.drop_set.includes('idx_unique'), 'a uniqueness constraint is never dropped');

  // The audit's drops are rolled back.
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'`).get() as { n: number }).n, 8);
});

test('the drop set takes unused indexes first, then replaceable ones largest first', () => {
  const replaceable = (sizes: Map<string, number>) => {
    const { drop_set: dropSet } = auditIndexes(fixture(), 'ev', statements, sizes);
    return dropSet.filter(name => name === 'idx_agent' || name === 'idx_kind');
  };
  assert.deepEqual(replaceable(new Map([['idx_kind', 10], ['idx_agent', 1]])), ['idx_kind', 'idx_agent']);
  assert.deepEqual(replaceable(new Map([['idx_kind', 1], ['idx_agent', 10]])), ['idx_agent', 'idx_kind']);
  const result = auditIndexes(fixture(), 'ev', statements, new Map([['idx_unused', 5], ['idx_agent', 3], ['idx_study', 100]]));
  const unused = result.verdicts.filter(v => v.verdict === 'unused').map(v => v.name);
  assert.ok(unused.includes('idx_unused'));
  assert.deepEqual(result.drop_set.slice(0, unused.length), unused);
  assert.equal(result.drop_set_bytes, 8, 'only dropped indexes count');
});

test('an index no plan names is still needed when its predicate steers the planner', () => {
  // SQLite uses idx_model for "model IS NOT NULL" only while a partial index
  // with that predicate exists, though the plan never names the partial index.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ev (id INTEGER PRIMARY KEY, model TEXT, cost REAL);
    CREATE INDEX idx_model ON ev(model);
    CREATE INDEX idx_pending ON ev(id) WHERE cost IS NULL AND model IS NOT NULL;
  `);
  const sql = 'SELECT id FROM ev WHERE cost IS NULL AND model IS NOT NULL UNION ALL SELECT id FROM ev WHERE model IS NOT NULL';
  const result = auditIndexes(db, 'ev', [{ sql, params: [] }]);
  const pending = result.verdicts.find(v => v.name === 'idx_pending')!;
  if (pending.users === 0) {
    assert.equal(pending.verdict, 'needed', JSON.stringify(pending));
    assert.ok(!result.drop_set.includes('idx_pending'));
  } else assert.fail(`fixture no longer reproduces the indirect effect: ${JSON.stringify(explain(db, { sql, params: [] }))}`);
});

test('an index needed only by a statement a plan test explains is flagged', () => {
  const study = { sql: 'SELECT * FROM ev WHERE study = ?', params: ['s'] };
  const onlyExplained = auditIndexes(fixture(), 'ev', [{ ...study, origins: ['plan_test'] }]);
  assert.equal(onlyExplained.verdicts.find(v => v.name === 'idx_study')!.plan_tests_only, true);
  const alsoRun = auditIndexes(fixture(), 'ev', [{ ...study, origins: ['plan_test', 'route'] }]);
  assert.equal(alsoRun.verdicts.find(v => v.name === 'idx_study')!.plan_tests_only, false);
  const unknown = auditIndexes(fixture(), 'ev', [study]);
  assert.equal(unknown.verdicts.find(v => v.name === 'idx_study')!.plan_tests_only, false, 'no origin is not plan-test only');
});

test('a partial index traded for a full one is a regression, even with as many terms', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ev (id INTEGER PRIMARY KEY, session TEXT, source TEXT, at TEXT);
    CREATE INDEX idx_full ON ev(session, at, source);
    CREATE INDEX idx_import ON ev(session, at) WHERE source = 'import';
  `);
  const statement = { sql: "SELECT id FROM ev WHERE session = ? AND at > ? AND source = 'import'", params: ['s', 't'] };
  const before = explain(db, statement);
  assert.match(before.join(' '), /idx_import/, 'the fixture must start on the partial index');
  const result = auditIndexes(db, 'ev', [statement]);
  const partial = result.verdicts.find(v => v.name === 'idx_import')!;
  assert.equal(partial.verdict, 'needed');
  assert.ok(partial.regressions[0].regressions.includes('loses_partial_filter'), JSON.stringify(partial.regressions));
  assert.ok(!result.drop_set.includes('idx_import'));
});

test('an index a statement names with INDEXED BY is needed', () => {
  const db = fixture();
  const pinned = [{ sql: 'SELECT id FROM ev INDEXED BY idx_unused WHERE created > ?', params: ['x'] }];
  const result = auditIndexes(db, 'ev', pinned);
  const verdict = result.verdicts.find(v => v.name === 'idx_unused')!;
  assert.equal(verdict.verdict, 'needed');
  assert.deepEqual(verdict.regressions[0].regressions, ['statement_fails']);
  assert.ok(!result.drop_set.includes('idx_unused'));
});

test('regressions reports what a plan lost, not what it kept', () => {
  const sql = 'SELECT COUNT(*) FROM ev WHERE agent = ? ORDER BY created';
  const covering = ['SEARCH ev USING COVERING INDEX a (agent=? AND created>?)'];
  assert.deepEqual(regressions(sql, covering, covering), []);
  assert.deepEqual(regressions(sql, covering, ['SEARCH ev USING COVERING INDEX b (agent=?)']), ['fewer_index_terms']);
  assert.deepEqual(regressions(sql, covering, ['SEARCH ev USING INDEX b (agent=? AND created>?)']), ['row_lookups', 'aggregate_row_lookups']);
  assert.deepEqual(regressions(sql, ['SCAN ev'], ['SCAN ev']), [], 'an existing scan is not new');
  assert.ok(regressions(sql, covering, ['SCAN ev', 'USE TEMP B-TREE FOR ORDER BY']).includes('temp_btree'));
  assert.ok(regressions(sql, ['SCAN s', 'SEARCH ev USING INDEX x (session=?)'], ['SCAN s', 'SEARCH ev USING AUTOMATIC COVERING INDEX (session=?)']).includes('automatic_index'));
});

test('indexesInPlan names covering and plain index uses, not automatic ones', () => {
  assert.deepEqual(indexesInPlan([
    'SEARCH e USING COVERING INDEX idx_a (x=?)',
    'SEARCH s USING INDEX idx_b (y=?)',
    'SEARCH t USING AUTOMATIC COVERING INDEX (z=?)',
    'SCAN u',
  ]), ['idx_a', 'idx_b']);
});

test('replicateSchema copies tables, indexes, virtual tables and triggers without rows', () => {
  const source = fixture();
  source.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
    CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id');
    CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body); END;
    INSERT INTO ev (agent) VALUES ('a');
    INSERT INTO notes (body) VALUES ('hello');
  `);
  const copy = new Database(':memory:');
  replicateSchema(source, copy);
  const objects = (db: Database.Database) => db.prepare(`SELECT type, name FROM sqlite_master ORDER BY type, name`).all();
  assert.deepEqual(objects(copy), objects(source));
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM ev').get() as { n: number }).n, 0);
  for (const statement of statements) assert.deepEqual(explain(copy, statement), explain(source, statement));
});

test('recorded parameters survive serialization, including bigint and buffers', () => {
  const params = [1, 'a', null, 2n ** 70n, Buffer.from([1, 2, 3]), { named: 'x' }];
  assert.deepEqual(reviveParams(serializeParams(params)), params);
});
