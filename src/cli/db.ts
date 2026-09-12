/**
 * Open the local database for a CLI read after global --db-path handling has
 * run. Keep these imports dynamic: config snapshots process.env on import.
 */
export async function initReadDb(): Promise<{ closeDb: () => void }> {
  const { ensureSchemaForRead } = await import('../db/schema.js');
  const { closeDb } = await import('../db/connection.js');
  ensureSchemaForRead();
  return { closeDb };
}
