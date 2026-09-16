/** Import content-free receipts from an operator-selected, host-owned spool.
 * This is not transcript ingestion and never creates session or usage events.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

interface ExecutionReceipt {
  schema_version: 'execution.v1';
  execution_id: string;
  run_id: string;
  producer: string;
  agent: string;
  role: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
}

function receipt(value: unknown): ExecutionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid receipt');
  const row = value as Record<string, unknown>;
  const keys = ['schema_version', 'execution_id', 'run_id', 'producer', 'agent', 'role', 'started_at', 'finished_at', 'exit_code'];
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) throw new Error('Invalid fields');
  const matches = (key: string, expression: RegExp) => typeof row[key] === 'string' && expression.test(row[key]);
  const timestamp = (value: unknown) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|\+00:00)$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value.replace('+00:00', 'Z');
  if (row.schema_version !== 'execution.v1'
    || !matches('execution_id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    || !matches('run_id', /^[0-9a-f]{64}$/) || !matches('producer', /^[a-z][a-z0-9_-]{0,63}$/)
    || !['claude', 'codex', 'antigravity'].includes(String(row.agent))
    || !['worker', 'judge', 'validation'].includes(String(row.role))
    || !timestamp(row.started_at)
    || (row.finished_at !== null && (!timestamp(row.finished_at)
      || Date.parse(String(row.finished_at)) < Date.parse(String(row.started_at))))
    || ((row.finished_at === null) !== (row.exit_code === null))
    || (row.exit_code !== null && (!Number.isInteger(row.exit_code)
      || Number(row.exit_code) < -255 || Number(row.exit_code) > 255))) throw new Error('Invalid receipt');
  return { ...row, started_at: new Date(String(row.started_at)).toISOString(),
    finished_at: row.finished_at === null ? null : new Date(String(row.finished_at)).toISOString() } as ExecutionReceipt;
}

export function syncExecutionReceipts(db: Database, directory: string | undefined) {
  const stats = { imported: 0, unchanged: 0, errors: 0 };
  if (!directory) return stats;
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
      || root.uid !== process.getuid?.()) throw new Error('Unsafe spool');
    const files = fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    if (files.length > 10_000) throw new Error('Spool limit exceeded');
    const apply = db.transaction((item: ExecutionReceipt) => {
      const previous = db.prepare('SELECT * FROM execution_receipts WHERE producer = ? AND execution_id = ?')
        .get(item.producer, item.execution_id) as ExecutionReceipt | undefined;
      if (previous) {
        for (const key of ['run_id', 'agent', 'role', 'started_at'] as const) {
          if (previous[key] !== item[key]) throw new Error('Conflicting execution identity');
        }
        if (previous.finished_at !== null) {
          if (item.finished_at !== null && (item.finished_at !== previous.finished_at || item.exit_code !== previous.exit_code)) {
            throw new Error('Conflicting terminal receipt');
          }
          return false; // Old start receipts cannot roll back a terminal outcome.
        }
        if (item.finished_at === null) return false;
      }
      db.prepare(`INSERT INTO execution_receipts
        (execution_id, run_id, producer, agent, role, started_at, finished_at, exit_code)
        VALUES (@execution_id, @run_id, @producer, @agent, @role, @started_at, @finished_at, @exit_code)
        ON CONFLICT(producer, execution_id) DO UPDATE SET
          finished_at=excluded.finished_at, exit_code=excluded.exit_code`).run(item);
      return true;
    });
    for (const name of files) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > 4096 || info.uid !== root.uid || (info.mode & 0o077) !== 0) throw new Error('Unsafe receipt');
        const bytes = Buffer.alloc(4097);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (length > 4096) throw new Error('Receipt too large');
        const item = receipt(JSON.parse(bytes.subarray(0, length).toString('utf8')));
        if (name !== `${item.execution_id}.json`) throw new Error('Receipt identity mismatch');
        if (apply.immediate(item)) stats.imported++; else stats.unchanged++;
      } catch { stats.errors++; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors++;
  }
  return stats;
}
