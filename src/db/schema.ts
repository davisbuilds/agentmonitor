import { getDb } from './connection.js';
import {
  TRACE_QUALITY_EXPORT_PROVIDERS,
  TRACE_QUALITY_EXPORT_STATUSES,
  TRACE_QUALITY_OBSERVATION_TYPES,
  TRACE_QUALITY_PAYLOAD_POLICIES,
  TRACE_QUALITY_PROJECTION_STATUSES,
  TRACE_QUALITY_PROMPT_REF_SOURCES,
  TRACE_QUALITY_SCORE_SOURCES,
  TRACE_QUALITY_SCORE_TARGET_TYPES,
  TRACE_QUALITY_SCORE_VALUE_TYPES,
  TRACE_QUALITY_SOURCE_KINDS,
} from '../trace-quality/constants.js';

function sqlStringList(values: readonly string[]): string {
  return values.map(value => `'${value.replaceAll("'", "''")}'`).join(', ');
}

function createTraceQualityPromptRefsSql(tableName = 'trace_quality_prompt_refs', ifNotExists = false): string {
  const createTable = ifNotExists ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE TABLE';
  return `
    ${createTable} ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT,
      label TEXT,
      source TEXT NOT NULL CHECK (source IN (${sqlStringList(TRACE_QUALITY_PROMPT_REF_SOURCES)})),
      content_hash TEXT,
      file_path TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;
}

function ensureTraceQualityPromptRefSourceCheck(): void {
  const db = getDb();
  const tableSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='trace_quality_prompt_refs'"
  ).get() as { sql: string } | undefined)?.sql ?? '';

  if (!tableSql || TRACE_QUALITY_PROMPT_REF_SOURCES.every(source => tableSql.includes(`'${source}'`))) {
    return;
  }

  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true }));
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(createTraceQualityPromptRefsSql('trace_quality_prompt_refs_migrated'));
    db.exec(`
      INSERT INTO trace_quality_prompt_refs_migrated (
        id, name, version, label, source, content_hash, file_path, metadata_json, created_at
      )
      SELECT id, name, version, label, source, content_hash, file_path, metadata_json, created_at
      FROM trace_quality_prompt_refs;

      DROP TABLE trace_quality_prompt_refs;
      ALTER TABLE trace_quality_prompt_refs_migrated RENAME TO trace_quality_prompt_refs;

      CREATE INDEX IF NOT EXISTS idx_tq_prompt_refs_name_version ON trace_quality_prompt_refs(name, version);
      CREATE INDEX IF NOT EXISTS idx_tq_prompt_refs_source ON trace_quality_prompt_refs(source);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_quotas (
      provider TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unavailable',
      source TEXT,
      updated_at TEXT,
      account_label TEXT,
      plan_type TEXT,
      limit_id TEXT,
      limit_name TEXT,
      error_message TEXT,
      primary_used_percent REAL,
      primary_window_minutes INTEGER,
      primary_resets_at TEXT,
      secondary_used_percent REAL,
      secondary_window_minutes INTEGER,
      secondary_resets_at TEXT,
      credits_has_credits INTEGER,
      credits_unlimited INTEGER,
      credits_balance TEXT,
      raw_payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_provider_quotas_updated_at ON provider_quotas(updated_at DESC);
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

  const providerQuotaColumns = new Set<string>(
    (db.prepare(`PRAGMA table_info(provider_quotas)`).all() as Array<{ name: string }>).map(col => col.name)
  );

  if (!providerQuotaColumns.has('provider') || !providerQuotaColumns.has('agent_type')) {
    db.exec('DROP TABLE IF EXISTS provider_quotas');
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_quotas (
        provider TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unavailable',
        source TEXT,
        updated_at TEXT,
        account_label TEXT,
        plan_type TEXT,
        limit_id TEXT,
        limit_name TEXT,
        error_message TEXT,
        primary_used_percent REAL,
        primary_window_minutes INTEGER,
        primary_resets_at TEXT,
        secondary_used_percent REAL,
        secondary_window_minutes INTEGER,
        secondary_resets_at TEXT,
        credits_has_credits INTEGER,
        credits_unlimited INTEGER,
        credits_balance TEXT,
        raw_payload TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_provider_quotas_updated_at ON provider_quotas(updated_at DESC);
    `);
  } else {
    if (!providerQuotaColumns.has('status')) {
      db.exec("ALTER TABLE provider_quotas ADD COLUMN status TEXT NOT NULL DEFAULT 'unavailable'");
    }
    if (!providerQuotaColumns.has('source')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN source TEXT');
    }
    if (!providerQuotaColumns.has('updated_at')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN updated_at TEXT');
    }
    if (!providerQuotaColumns.has('account_label')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN account_label TEXT');
    }
    if (!providerQuotaColumns.has('plan_type')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN plan_type TEXT');
    }
    if (!providerQuotaColumns.has('limit_id')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN limit_id TEXT');
    }
    if (!providerQuotaColumns.has('limit_name')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN limit_name TEXT');
    }
    if (!providerQuotaColumns.has('error_message')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN error_message TEXT');
    }
    if (!providerQuotaColumns.has('primary_used_percent')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN primary_used_percent REAL');
    }
    if (!providerQuotaColumns.has('primary_window_minutes')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN primary_window_minutes INTEGER');
    }
    if (!providerQuotaColumns.has('primary_resets_at')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN primary_resets_at TEXT');
    }
    if (!providerQuotaColumns.has('secondary_used_percent')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN secondary_used_percent REAL');
    }
    if (!providerQuotaColumns.has('secondary_window_minutes')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN secondary_window_minutes INTEGER');
    }
    if (!providerQuotaColumns.has('secondary_resets_at')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN secondary_resets_at TEXT');
    }
    if (!providerQuotaColumns.has('credits_has_credits')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN credits_has_credits INTEGER');
    }
    if (!providerQuotaColumns.has('credits_unlimited')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN credits_unlimited INTEGER');
    }
    if (!providerQuotaColumns.has('credits_balance')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN credits_balance TEXT');
    }
    if (!providerQuotaColumns.has('raw_payload')) {
      db.exec('ALTER TABLE provider_quotas ADD COLUMN raw_payload TEXT');
    }
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
      capabilities_json TEXT,
      file_path TEXT,
      file_size INTEGER,
      file_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bs_ended_at ON browsing_sessions(ended_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bs_project ON browsing_sessions(project);
    CREATE INDEX IF NOT EXISTS idx_bs_agent ON browsing_sessions(agent);
    CREATE INDEX IF NOT EXISTS idx_bs_started_at ON browsing_sessions(started_at);
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
  if (!browsingSessionColumns.has('capabilities_json')) {
    db.exec('ALTER TABLE browsing_sessions ADD COLUMN capabilities_json TEXT');
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
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id INTEGER,
      message_ordinal INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, message_ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_pm_session_ordinal ON pinned_messages(session_id, message_ordinal);
    CREATE INDEX IF NOT EXISTS idx_pm_created_at ON pinned_messages(created_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT,
      content TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      project TEXT,
      agent TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      analytics_summary_json TEXT NOT NULL,
      analytics_coverage_json TEXT NOT NULL,
      usage_summary_json TEXT NOT NULL,
      usage_coverage_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_insights_created_at ON insights(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insights_scope ON insights(kind, date_from, date_to, project, agent);
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_quality_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      browsing_session_id TEXT,
      source_trace_id TEXT,
      agent_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT,
      project TEXT,
      branch TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
      coverage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(coverage_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tq_traces_session ON trace_quality_traces(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tq_traces_browsing_session ON trace_quality_traces(browsing_session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tq_traces_started_at ON trace_quality_traces(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tq_traces_agent_type ON trace_quality_traces(agent_type);
    CREATE INDEX IF NOT EXISTS idx_tq_traces_source_trace_id ON trace_quality_traces(source_trace_id);

    CREATE TABLE IF NOT EXISTS trace_quality_observations (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_observation_id TEXT,
      session_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN (${sqlStringList(TRACE_QUALITY_SOURCE_KINDS)})),
      source_id TEXT,
      source_item_id TEXT,
      observation_type TEXT NOT NULL CHECK (observation_type IN (${sqlStringList(TRACE_QUALITY_OBSERVATION_TYPES)})),
      name TEXT NOT NULL,
      status TEXT,
      status_message TEXT,
      severity TEXT,
      model TEXT,
      tool_name TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      input_hash TEXT,
      output_hash TEXT,
      input_summary TEXT,
      output_summary TEXT,
      payload_policy TEXT NOT NULL DEFAULT 'summary_only' CHECK (payload_policy IN (${sqlStringList(TRACE_QUALITY_PAYLOAD_POLICIES)})),
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(trace_id) REFERENCES trace_quality_traces(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_observation_id) REFERENCES trace_quality_observations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tq_observations_trace ON trace_quality_observations(trace_id, started_at, id);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_parent ON trace_quality_observations(parent_observation_id);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_session ON trace_quality_observations(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_source ON trace_quality_observations(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_type ON trace_quality_observations(observation_type);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_model ON trace_quality_observations(model);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_tool_name ON trace_quality_observations(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tq_observations_payload_policy ON trace_quality_observations(payload_policy);

    CREATE TABLE IF NOT EXISTS trace_quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK (target_type IN (${sqlStringList(TRACE_QUALITY_SCORE_TARGET_TYPES)})),
      target_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK (value_type IN (${sqlStringList(TRACE_QUALITY_SCORE_VALUE_TYPES)})),
      numeric_value REAL,
      categorical_value TEXT,
      boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
      text_value TEXT,
      source TEXT NOT NULL CHECK (source IN (${sqlStringList(TRACE_QUALITY_SCORE_SOURCES)})),
      evaluator_name TEXT,
      comment TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tq_scores_target ON trace_quality_scores(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_tq_scores_name ON trace_quality_scores(name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tq_scores_source ON trace_quality_scores(source);

    ${createTraceQualityPromptRefsSql('trace_quality_prompt_refs', true)}

    CREATE INDEX IF NOT EXISTS idx_tq_prompt_refs_name_version ON trace_quality_prompt_refs(name, version);
    CREATE INDEX IF NOT EXISTS idx_tq_prompt_refs_source ON trace_quality_prompt_refs(source);

    CREATE TABLE IF NOT EXISTS trace_quality_observation_prompts (
      observation_id TEXT NOT NULL,
      prompt_ref_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (observation_id, prompt_ref_id),
      FOREIGN KEY(observation_id) REFERENCES trace_quality_observations(id) ON DELETE CASCADE,
      FOREIGN KEY(prompt_ref_id) REFERENCES trace_quality_prompt_refs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tq_observation_prompts_prompt_ref ON trace_quality_observation_prompts(prompt_ref_id);

    CREATE TABLE IF NOT EXISTS trace_quality_projection_state (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      projection_version TEXT NOT NULL,
      trace_id TEXT,
      observation_id TEXT,
      payload_hash TEXT,
      status TEXT NOT NULL CHECK (status IN (${sqlStringList(TRACE_QUALITY_PROJECTION_STATUSES)})),
      projected_at TEXT,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_table, source_id, projection_version),
      FOREIGN KEY(trace_id) REFERENCES trace_quality_traces(id) ON DELETE SET NULL,
      FOREIGN KEY(observation_id) REFERENCES trace_quality_observations(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tq_projection_state_status ON trace_quality_projection_state(status);
    CREATE INDEX IF NOT EXISTS idx_tq_projection_state_trace ON trace_quality_projection_state(trace_id);

    CREATE TABLE IF NOT EXISTS trace_quality_export_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK (provider IN (${sqlStringList(TRACE_QUALITY_EXPORT_PROVIDERS)})),
      local_trace_id TEXT NOT NULL,
      local_observation_id TEXT,
      external_trace_id TEXT,
      external_observation_id TEXT,
      payload_hash TEXT,
      status TEXT NOT NULL CHECK (status IN (${sqlStringList(TRACE_QUALITY_EXPORT_STATUSES)})),
      exported_at TEXT,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(local_trace_id) REFERENCES trace_quality_traces(id) ON DELETE CASCADE,
      FOREIGN KEY(local_observation_id) REFERENCES trace_quality_observations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tq_export_provider_status ON trace_quality_export_state(provider, status, exported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tq_export_local_trace ON trace_quality_export_state(local_trace_id);
    CREATE INDEX IF NOT EXISTS idx_tq_export_local_observation ON trace_quality_export_state(local_observation_id);
    CREATE INDEX IF NOT EXISTS idx_tq_export_external_trace ON trace_quality_export_state(provider, external_trace_id);
  `);

  ensureTraceQualityPromptRefSourceCheck();

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
