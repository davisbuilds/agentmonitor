import { getDb } from './connection.js';

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      name TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      project TEXT,
      branch TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      session_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('tool_use', 'session_start', 'session_end', 'response', 'error')),
      tool_name TEXT,
      status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      branch TEXT,
      project TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      client_timestamp TEXT,
      metadata TEXT DEFAULT '{}',
      payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);

  // Backward-compatible schema updates for existing local databases.
  const eventColumns = new Set<string>(
    (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map(col => col.name)
  );

  if (!eventColumns.has('client_timestamp')) {
    db.exec('ALTER TABLE events ADD COLUMN client_timestamp TEXT');
  }
  if (!eventColumns.has('payload_truncated')) {
    db.exec('ALTER TABLE events ADD COLUMN payload_truncated INTEGER NOT NULL DEFAULT 0');
  }

  db.exec('UPDATE events SET payload_truncated = 0 WHERE payload_truncated IS NULL');
}
