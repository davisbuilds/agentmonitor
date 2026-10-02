import type Database from 'better-sqlite3';
import { planFlags, type PlanFlag } from './plan-flags.js';

/**
 * Which indexes on a table the app's statements still need. Without
 * sqlite_stat1 (the app never runs ANALYZE) SQLite plans from the schema and
 * fixed estimates, not the data, so plans can be compared on an empty copy of
 * the schema; the caller confirms that against the real database.
 */

/** Where a statement came from: run by a test, explained by a plan test, or read by an app route. */
export type StatementOrigin = 'test_run' | 'plan_test' | 'route';

export interface AuditStatement { sql: string; params: unknown[] | null; origins?: StatementOrigin[] }

export type Regression = PlanFlag | 'fewer_index_terms' | 'loses_search_column' | 'automatic_index' | 'statement_fails' | 'loses_partial_filter';

export interface IndexVerdict {
  name: string;
  unique: boolean;
  /** Statements whose plan uses the index. */
  users: number;
  /**
   * unused: no plan uses it and none changes for the worse without it.
   * needed: some plan gets worse without it, even one that never names it
   * (a partial index's predicate can steer the planner).
   */
  verdict: 'constraint' | 'unused' | 'replaceable' | 'needed';
  /** Indexes the users' plans switch to when this one is dropped alone. */
  replacements: string[];
  regressions: Array<{ sql: string; before: string[]; after: string[]; regressions: Regression[]; origins: StatementOrigin[] }>;
  /**
   * Needed only by statements a plan test explains and nothing runs: the test
   * may pin a query shape the product no longer issues.
   */
  plan_tests_only: boolean;
}

/** Recreate a database's schema, without its rows, on an empty connection. */
export function replicateSchema(source: Database.Database, target: Database.Database) {
  const shadow = new Set((source.prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'`).all() as Array<{ name: string }>).map(row => row.name));
  const rows = source.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid
  `).all() as Array<{ type: string; name: string; sql: string }>;
  for (const row of rows) if (!shadow.has(row.name)) target.exec(row.sql);
}

/** Bind recorded parameters, or nulls when they were not recorded. */
function bind(db: Database.Database, sql: string, params: unknown[] | null) {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  if (params) return statement.all(...params);
  const count = (sql.match(/\?/g) ?? []).length;
  return statement.all(...Array.from({ length: count }, () => null));
}

export function explain(db: Database.Database, statement: AuditStatement): string[] {
  return (bind(db, statement.sql, statement.params) as Array<{ detail: string }>).map(row => row.detail);
}

export function indexesInPlan(plan: string[]): string[] {
  const names = new Set<string>();
  for (const step of plan) for (const match of step.matchAll(/USING (?:COVERING )?INDEX (\S+)/g)) names.add(match[1]);
  return [...names];
}

/**
 * Indexed search terms per table, by the column each constrains:
 * "(agent_type=? AND created_at>?)" searches agent_type and created_at.
 */
function indexTerms(plan: string[]): Map<string, Set<string>> {
  const terms = new Map<string, Set<string>>();
  for (const step of plan) {
    const match = /^SEARCH (\w+)(?: AS \w+)? USING (?:COVERING |INTEGER PRIMARY KEY |PRIMARY KEY )?(?:INDEX \S+ )?\((.*)\)$/.exec(step);
    if (!match) continue;
    const columns = terms.get(match[1]) ?? new Set<string>();
    for (const term of match[2].split(' AND ')) columns.add(/^(<expr>|[\w.]+)/.exec(term)?.[1] ?? term);
    terms.set(match[1], columns);
  }
  return terms;
}

/** Names of a table's indexes, and which of them are partial (CREATE INDEX ... WHERE). */
export interface TableIndexes { all: Set<string>; partial: Set<string> }

/**
 * What got worse from one plan to the next: a new plan hint, an index SQLite
 * must build for each run, a search on fewer indexed terms or that no longer
 * constrains a column it did (study_id=? traded for source=? has as many terms
 * but matches far more rows), or a partial index traded for a full one, which
 * keeps its search terms but visits every row the partial predicate skipped.
 */
export function regressions(sql: string, before: string[], after: string[], indexes?: TableIndexes): Regression[] {
  const had = new Set(planFlags(sql, before));
  const found: Regression[] = planFlags(sql, after).filter(flag => !had.has(flag));
  const automatic = (plan: string[]) => plan.some(step => /\bAUTOMATIC\b.*\bINDEX\b/.test(step));
  if (automatic(after) && !automatic(before)) found.push('automatic_index');
  const termsBefore = indexTerms(before);
  const termsAfter = indexTerms(after);
  for (const [table, columns] of termsBefore) {
    const after = termsAfter.get(table) ?? new Set<string>();
    if (after.size < columns.size) found.push('fewer_index_terms');
    else if ([...columns].some(column => !after.has(column))) found.push('loses_search_column');
    if (found.includes('fewer_index_terms') || found.includes('loses_search_column')) break;
  }
  if (indexes) {
    const usedAfter = indexesInPlan(after);
    const lostPartial = indexesInPlan(before).some(name => indexes.partial.has(name) && !usedAfter.includes(name));
    if (lostPartial && usedAfter.some(name => indexes.all.has(name) && !indexes.partial.has(name))) found.push('loses_partial_filter');
  }
  return found;
}

/** A statement that names the index (INDEXED BY) no longer prepares without it. */
function planOrFailure(db: Database.Database, statement: AuditStatement): string[] | null {
  try { return explain(db, statement); } catch { return null; }
}

function compare(statement: AuditStatement, before: string[], after: string[] | null, indexes: TableIndexes): Regression[] {
  return after ? regressions(statement.sql, before, after, indexes) : ['statement_fails'];
}

function withDropped<T>(db: Database.Database, names: string[], run: () => T): T {
  db.exec('BEGIN');
  try {
    for (const name of names) db.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
    return run();
  } finally { db.exec('ROLLBACK'); }
}

const preview = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Classify each index on `table` against the statements' plans on `db` (the
 * schema copy), then grow a drop set that leaves every statement's plan free of
 * regressions: unused indexes first, then replaceable ones, largest first,
 * re-checking all statements against the whole set each time.
 */
export function auditIndexes(db: Database.Database, table: string, statements: AuditStatement[], bytes: Map<string, number> = new Map()) {
  const baseline = statements.map(statement => explain(db, statement));
  const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`)
    .all(table) as Array<{ name: string; sql: string }>;
  const tableIndexes: TableIndexes = {
    all: new Set(indexes.map(index => index.name)),
    partial: new Set(indexes.filter(index => /\bWHERE\b/i.test(index.sql)).map(index => index.name)),
  };

  const verdicts: IndexVerdict[] = indexes.map(index => {
    const unique = /^CREATE\s+UNIQUE\s/i.test(index.sql);
    const users = baseline.flatMap((plan, i) => indexesInPlan(plan).includes(index.name) ? [i] : []);
    const verdict: IndexVerdict = { name: index.name, unique, users: users.length, verdict: 'unused', replacements: [], regressions: [], plan_tests_only: false };
    if (unique) { verdict.verdict = 'constraint'; return verdict; }
    const replacements = new Set<string>();
    withDropped(db, [index.name], () => {
      statements.forEach((statement, i) => {
        const after = planOrFailure(db, statement);
        if (users.includes(i)) for (const name of indexesInPlan(after ?? [])) replacements.add(name);
        const found = compare(statement, baseline[i], after, tableIndexes);
        if (found.length) verdict.regressions.push({ sql: preview(statement.sql), before: baseline[i], after: after ?? [], regressions: found, origins: statement.origins ?? [] });
      });
    });
    verdict.replacements = [...replacements].sort();
    verdict.verdict = verdict.regressions.length ? 'needed' : users.length ? 'replaceable' : 'unused';
    verdict.plan_tests_only = verdict.regressions.length > 0
      && verdict.regressions.every(entry => entry.origins.length > 0 && entry.origins.every(origin => origin === 'plan_test'));
    return verdict;
  });

  const size = (name: string) => bytes.get(name) ?? 0;
  const candidates = [
    ...verdicts.filter(v => v.verdict === 'unused'),
    ...verdicts.filter(v => v.verdict === 'replaceable').sort((a, b) => size(b.name) - size(a.name) || a.name.localeCompare(b.name)),
  ];
  const dropSet: string[] = [];
  const kept: Array<{ name: string; sql: string; regressions: Regression[] }> = [];
  for (const candidate of candidates) {
    const trial = [...dropSet, candidate.name];
    const blocking = withDropped(db, trial, () => {
      for (let i = 0; i < statements.length; i++) {
        const found = compare(statements[i], baseline[i], planOrFailure(db, statements[i]), tableIndexes);
        if (found.length) return { name: candidate.name, sql: preview(statements[i].sql), regressions: found };
      }
      return null;
    });
    if (blocking) kept.push(blocking); else dropSet.push(candidate.name);
  }
  return {
    verdicts,
    drop_set: dropSet,
    drop_set_bytes: dropSet.reduce((sum, name) => sum + size(name), 0),
    kept_by_joint_check: kept,
  };
}
