import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

const MIGRATION_WORKER = String.raw`
  import fs from 'node:fs';

  const [, dbPath, readyPath, releasePath] = process.argv;
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const { getDb, closeDb } = await import('./src/db/connection.ts');
  const { runDataMigrations } = await import('./src/db/schema.ts');
  const db = getDb();
  const originalTransaction = db.transaction.bind(db);
  db.transaction = (fn) => {
    const run = originalTransaction(fn);
    const waitForRelease = () => {
      fs.writeFileSync(readyPath, 'ready');
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 10);
    };
    const wrapped = (...args) => {
      waitForRelease();
      return run(...args);
    };
    wrapped.immediate = (...args) => {
      waitForRelease();
      return run.immediate(...args);
    };
    return wrapped;
  };
  runDataMigrations(db);
  closeDb();
`;

const STRUCTURAL_UPGRADE_WORKER = String.raw`
  import fs from 'node:fs';

  const [, dbPath, readyPath, releasePath] = process.argv;
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const { getDb, closeDb } = await import('./src/db/connection.ts');
  const { initSchema } = await import('./src/db/schema.ts');
  const db = getDb();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql, ...args) => {
    const statement = originalPrepare(sql, ...args);
    if (!String(sql).includes('PRAGMA table_info(browsing_sessions)')) return statement;
    const originalAll = statement.all.bind(statement);
    statement.all = (...allArgs) => {
      const columns = originalAll(...allArgs);
      fs.writeFileSync(readyPath, 'ready');
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 10);
      return columns;
    };
    return statement;
  };
  initSchema();
  closeDb();
`;

function runWorker(script: string, dbPath: string, readyPath: string, releasePath: string): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', script,
      dbPath, readyPath, releasePath,
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function waitForFiles(paths: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(filePath => fs.existsSync(filePath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for migration workers: ${paths.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForAnyFile(paths: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.some(filePath => fs.existsSync(filePath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for a schema worker: ${paths.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('concurrent migration runners apply a non-idempotent correction once', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-migration-concurrency-'));
  const dbPath = path.join(tempDir, 'agentmonitor.db');
  const readyPaths = [path.join(tempDir, 'ready-1'), path.join(tempDir, 'ready-2')];
  const releasePath = path.join(tempDir, 'release');
  process.env.AGENTMONITOR_DB_PATH = dbPath;

  const { initSchema } = await import('../src/db/schema.js');
  const { closeDb, getDb } = await import('../src/db/connection.js');
  try {
    initSchema();
    const db = getDb();
    assert.equal(path.resolve(db.name), path.resolve(dbPath));
    db.prepare(`
      INSERT INTO events (
        event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
        model, cost_usd, cache_read_tokens, cache_write_tokens, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'concurrent-backfill', 'session', 'codex', 'llm_response', 'success',
      100_000, 0, 'gpt-5.4', 1.01, 40_000, 0, 'import',
    );
    db.pragma('user_version = 0');
    closeDb();

    const workers = readyPaths.map(readyPath => runWorker(MIGRATION_WORKER, dbPath, readyPath, releasePath));
    let readinessError: unknown;
    try {
      await waitForFiles(readyPaths, 5_000);
    } catch (error) {
      readinessError = error;
    } finally {
      fs.writeFileSync(releasePath, 'release');
    }

    const results = await Promise.all(workers);
    if (readinessError) throw readinessError;
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const row = getDb().prepare(
      'SELECT tokens_in FROM events WHERE event_id = ?'
    ).get('concurrent-backfill') as { tokens_in: number };
    assert.equal(row.tokens_in, 60_000, 'cache-inclusive input correction ran more than once');
  } finally {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('concurrent schema initializers serialize additive column upgrades', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-structural-concurrency-'));
  const dbPath = path.join(tempDir, 'agentmonitor.db');
  const readyPaths = [path.join(tempDir, 'ready-1'), path.join(tempDir, 'ready-2')];
  const releasePath = path.join(tempDir, 'release');
  try {
    const Database = (await import('better-sqlite3')).default;
    const legacyDb = new Database(dbPath);
    legacyDb.pragma('journal_mode = WAL');
    legacyDb.exec(`
      CREATE TABLE browsing_sessions (
        id TEXT PRIMARY KEY,
        project TEXT,
        agent TEXT NOT NULL,
        first_message TEXT,
        started_at TEXT,
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        user_message_count INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT,
        relationship_type TEXT,
        file_path TEXT,
        file_size INTEGER,
        file_hash TEXT
      )
    `);
    legacyDb.close();

    const workers = readyPaths.map(readyPath => (
      runWorker(STRUCTURAL_UPGRADE_WORKER, dbPath, readyPath, releasePath)
    ));
    let readinessError: unknown;
    try {
      await waitForAnyFile(readyPaths, 5_000);
      await waitForFiles(readyPaths, 1_000).catch(() => undefined);
    } catch (error) {
      readinessError = error;
    } finally {
      fs.writeFileSync(releasePath, 'release');
    }

    const results = await Promise.all(workers);
    if (readinessError) throw readinessError;
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const verified = new Database(dbPath, { readonly: true });
    const columns = new Set(
      (verified.prepare('PRAGMA table_info(browsing_sessions)').all() as Array<{ name: string }>).map(row => row.name),
    );
    verified.close();
    assert.ok(columns.has('live_status'));
    assert.ok(columns.has('project_identity'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
