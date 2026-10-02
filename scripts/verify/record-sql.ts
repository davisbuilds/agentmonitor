/**
 * Preload for `node --import`: records each distinct SQL statement a process
 * runs through better-sqlite3, with the parameters of its first run, so the
 * index-audit probe can explain every statement a test suite exercises,
 * writers included. Inert unless AGENTMONITOR_RECORD_SQL_DIR is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Parameters larger than this are dropped; plans depend on their count, not their values. */
const MAX_PARAMS_JSON = 10_000;

export interface RecordedSql { sql: string; params: unknown[] | null }

export function serializeParams(params: unknown[]): string {
  return JSON.stringify(params, (_key, value: unknown) => typeof value === 'bigint' ? { $bigint: value.toString() } : value);
}

export function reviveParams(json: string): unknown[] {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.$bigint === 'string') return BigInt(record.$bigint);
      if (record.type === 'Buffer' && Array.isArray(record.data)) return Buffer.from(record.data as number[]);
    }
    return value;
  }) as unknown[];
}

const dir = process.env.AGENTMONITOR_RECORD_SQL_DIR;
if (dir) {
  const seen = new Map<string, string | null>();
  const prepare = Database.prototype.prepare;
  let wrapped = false;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    if (!wrapped) {
      wrapped = true;
      const proto = Object.getPrototypeOf(statement) as Record<string, (...args: unknown[]) => unknown>;
      for (const method of ['all', 'get', 'iterate', 'run']) {
        const original = proto[method];
        proto[method] = function (this: Database.Statement, ...args: unknown[]) {
          if (!seen.has(this.source)) {
            let params: string | null = null;
            try {
              const json = serializeParams(args);
              if (json.length <= MAX_PARAMS_JSON) params = json;
            } catch { /* unserializable parameters: record the statement alone */ }
            seen.set(this.source, params);
          }
          return original.apply(this, args);
        };
      }
    }
    return statement;
  } as typeof Database.prototype.prepare;

  process.on('exit', () => {
    if (!seen.size) return;
    const lines = [...seen].map(([sql, params]) => JSON.stringify({ sql, params }));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${process.pid}.jsonl`), lines.join('\n') + '\n');
  });
}
