import { statSync } from 'node:fs';
import { notFound } from './errors.js';

/**
 * Open the local database for a CLI read after global --db-path handling has
 * run. Keep these imports dynamic: config snapshots process.env on import.
 */
export async function initReadDb({ requireConfiguredStore = false } = {}): Promise<{ closeDb: () => void }> {
  const { ensureSchemaForRead } = await import('../db/schema.js');
  const { closeDb, getDb } = await import('../db/connection.js');
  const configuredPath = requireConfiguredStore && process.env.AGENTMONITOR_DB_PATH?.trim();
  if (configuredPath && configuredPath !== ':memory:' && !statSync(configuredPath, { throwIfNoEntry: false })) {
    throw notFound(`Database not found: ${configuredPath}`);
  }
  ensureSchemaForRead(getDb({ fileMustExist: Boolean(configuredPath) }));
  return { closeDb };
}
