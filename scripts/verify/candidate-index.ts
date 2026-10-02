import type Database from 'better-sqlite3';

// Only the operation prefix is recognized here. SQLite parses the complete SQL;
// prepare() rejects multiple statements before run() can have any side effects.
const gap = String.raw`(?:\s|--[^\r\n]*(?:\r?\n|$)|/\*[\s\S]*?\*/)`;
const createIndex = new RegExp(`^${gap}*CREATE${gap}+(?:UNIQUE${gap}+)?INDEX${gap}+`, 'i');

export function createCandidateIndex(db: Database.Database, sql: string): string {
  if (!createIndex.test(sql)) throw new Error('--index-sql requires a single CREATE INDEX or CREATE UNIQUE INDEX statement');
  const statement = db.prepare(sql);
  const names = () => new Set((db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'index'").all() as Array<{ name: string }>).map(row => row.name));
  return db.transaction(() => {
    const before = names();
    statement.run();
    const added = [...names()].filter(name => !before.has(name));
    if (added.length !== 1) throw new Error('--index-sql must create one new index in the snapshot main database; use --index for an existing index');
    return added[0];
  })();
}
