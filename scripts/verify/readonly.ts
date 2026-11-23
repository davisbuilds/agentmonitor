import Database from 'better-sqlite3';

/**
 * Every probe that reads a database opens it here. `readonly` refuses writes at
 * the file level and `query_only` refuses them per statement, so a probe cannot
 * modify the installed database even through a statement that would.
 */
export function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  // WHY: Use the server's page-cache size to make the timings comparable.
  db.pragma('cache_size = -64000');
  return db;
}
