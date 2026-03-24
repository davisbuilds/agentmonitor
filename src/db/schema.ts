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
      event_type TEXT NOT NULL,
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
      payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
      model TEXT,
      cost_usd REAL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      source TEXT DEFAULT 'api'
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);

  // Import state tracking - avoids re-importing unchanged files
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_state (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      source TEXT NOT NULL,
      events_imported INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
  if (!eventColumns.has('model')) {
    db.exec('ALTER TABLE events ADD COLUMN model TEXT');
  }
  if (!eventColumns.has('cost_usd')) {
    db.exec('ALTER TABLE events ADD COLUMN cost_usd REAL');
  }
  if (!eventColumns.has('cache_read_tokens')) {
    db.exec('ALTER TABLE events ADD COLUMN cache_read_tokens INTEGER DEFAULT 0');
  }
  if (!eventColumns.has('cache_write_tokens')) {
    db.exec('ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER DEFAULT 0');
  }
  if (!eventColumns.has('source')) {
    db.exec("ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'api'");
  }

  db.exec('UPDATE events SET payload_truncated = 0 WHERE payload_truncated IS NULL');
  db.exec(`
    UPDATE events
    SET metadata = json_quote(CAST(metadata AS TEXT))
    WHERE metadata IS NOT NULL AND json_valid(metadata) = 0
  `);

  // Remove restrictive CHECK constraint on event_type if present on existing databases.
  // SQLite does not support ALTER CONSTRAINT, so we recreate the table.
  const tableSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
  ).get() as { sql: string } | undefined)?.sql ?? '';

  if (tableSql.includes('CHECK (event_type IN')) {
    db.exec(`
      CREATE TABLE events_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        session_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
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
        payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
        model TEXT,
        cost_usd REAL,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        source TEXT DEFAULT 'api'
      );

      INSERT INTO events_migrated (
        id, event_id, schema_version, session_id, agent_type, event_type, tool_name,
        status, tokens_in, tokens_out, branch, project, duration_ms,
        created_at, client_timestamp, metadata, payload_truncated,
        model, cost_usd, cache_read_tokens, cache_write_tokens, source
      )
      SELECT
        id, event_id, schema_version, session_id, agent_type, event_type, tool_name,
        status, tokens_in, tokens_out, branch, project, duration_ms,
        created_at, client_timestamp, metadata, payload_truncated,
        model, cost_usd,
        COALESCE(cache_read_tokens, 0), COALESCE(cache_write_tokens, 0),
        COALESCE(source, 'api')
      FROM events;

      DROP TABLE events;
      ALTER TABLE events_migrated RENAME TO events;

      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
      CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_type);
      CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
    `);
  }

  // Create index on model column after migrations ensure the column exists.
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_model ON events(model)');

  // --- V2 tables: session browser, messages, tool calls, FTS ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS browsing_sessions (
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
      live_status TEXT,
      last_item_at TEXT,
      integration_mode TEXT,
      fidelity TEXT,
      file_path TEXT,
      file_size INTEGER,
      file_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bs_ended_at ON browsing_sessions(ended_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bs_project ON browsing_sessions(project);
    CREATE INDEX IF NOT EXISTS idx_bs_agent ON browsing_sessions(agent);
    CREATE INDEX IF NOT EXISTS idx_bs_started_at ON browsing_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_bs_last_item_at ON browsing_sessions(last_item_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bs_live_status ON browsing_sessions(live_status);
  `);

  const browsingSessionColumns = new Set<string>(
    (db.prepare(`PRAGMA table_info(browsing_sessions)`).all() as Array<{ name: string }>).map(col => col.name)
  );

  if (!browsingSessionColumns.has('live_status')) {
    db.exec('ALTER TABLE browsing_sessions ADD COLUMN live_status TEXT');
  }
  if (!browsingSessionColumns.has('last_item_at')) {
    db.exec('ALTER TABLE browsing_sessions ADD COLUMN last_item_at TEXT');
  }
  if (!browsingSessionColumns.has('integration_mode')) {
    db.exec('ALTER TABLE browsing_sessions ADD COLUMN integration_mode TEXT');
  }
  if (!browsingSessionColumns.has('fidelity')) {
    db.exec('ALTER TABLE browsing_sessions ADD COLUMN fidelity TEXT');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_bs_last_item_at ON browsing_sessions(last_item_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bs_live_status ON browsing_sessions(live_status)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      has_thinking INTEGER NOT NULL DEFAULT 0,
      has_tool_use INTEGER NOT NULL DEFAULT 0,
      content_length INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      category TEXT,
      tool_use_id TEXT,
      input_json TEXT,
      result_content TEXT,
      result_content_length INTEGER,
      subagent_session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tc_session_id ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tc_category ON tool_calls(category);
    CREATE INDEX IF NOT EXISTS idx_tc_tool_name ON tool_calls(tool_name);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      source_turn_id TEXT,
      status TEXT,
      title TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_st_session_started_at ON session_turns(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_st_source_turn_id ON session_turns(source_turn_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_id INTEGER,
      ordinal INTEGER NOT NULL DEFAULT 0,
      source_item_id TEXT,
      kind TEXT NOT NULL,
      status TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT,
      FOREIGN KEY(turn_id) REFERENCES session_turns(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_si_session_created_at ON session_items(session_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_si_turn_ordinal ON session_items(turn_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_si_source_item_id ON session_items(source_item_id);
  `);

  // FTS5 full-text search on message content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `);

  // Triggers to keep FTS index in sync with messages table
  const ftsTriggersExist = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='messages_fts_insert'"
  ).get();

  if (!ftsTriggersExist) {
    db.exec(`
      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  // File-watcher state tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS watched_files (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      file_mtime TEXT,
      status TEXT NOT NULL DEFAULT 'parsed',
      last_parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
