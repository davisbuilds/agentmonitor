import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point this spec file at its own temporary database, and return its directory.
 *
 * Playwright runs several spec files in one worker process, and `config`
 * snapshots AGENTMONITOR_DB_PATH when it is first imported. Setting the
 * variable alone therefore left every later file in the worker on the first
 * file's database, with the first file's rows: exact totals failed on the first
 * attempt and passed on a retry, in a fresh worker. The open connection is
 * closed so the next query opens the new path.
 */
export async function useIsolatedDb(prefix: string): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const { closeDb } = await import('../src/db/connection.js');
  const { config } = await import('../src/config.js');
  closeDb();
  config.dbPath = dbPath;
  return tempDir;
}
