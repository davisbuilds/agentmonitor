import { getDb } from './connection.js';
import type {
  BrowsingSessionRow,
  BrowsingSessionDbRow,
  LiveSessionRow,
  LiveTurnRow,
  LiveItemRow,
  MessageRow,
  CountResult,
  SessionsListParams,
  MessagesListParams,
  LiveSessionsListParams,
  LiveItemsListParams,
  SearchParams,
  AnalyticsParams,
  AnalyticsSummary,
  ActivityDataPoint,
  ProjectBreakdown,
  ToolUsageStat,
} from '../api/v2/types.js';
import { inferProjectionCapabilities } from '../live/projector.js';

function mapBrowsingSessionRow(row: BrowsingSessionDbRow): BrowsingSessionRow {
  return {
    id: row.id,
    project: row.project,
    agent: row.agent,
    first_message: row.first_message,
    started_at: row.started_at,
    ended_at: row.ended_at,
    message_count: row.message_count,
    user_message_count: row.user_message_count,
    parent_session_id: row.parent_session_id,
    relationship_type: row.relationship_type,
    live_status: row.live_status,
    last_item_at: row.last_item_at,
    integration_mode: row.integration_mode,
    fidelity: row.fidelity,
    capabilities: inferProjectionCapabilities({
      capabilities_json: row.capabilities_json,
      fidelity: row.fidelity,
      integration_mode: row.integration_mode,
    }),
    file_path: row.file_path,
    file_size: row.file_size,
    file_hash: row.file_hash,
  };
}

// --- Sessions ---

interface SessionsResult {
  data: BrowsingSessionRow[];
  total: number;
  cursor?: string;
}

interface TimeCursor {
  sort_at: string;
  id: string;
}

function encodeTimeCursor(cursor: TimeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function decodeTimeCursor(cursor: string | undefined): TimeCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Partial<TimeCursor>;
    if (typeof parsed.sort_at === 'string' && typeof parsed.id === 'string') {
      return { sort_at: parsed.sort_at, id: parsed.id };
    }
  } catch {
    // Fall back to legacy timestamp-only cursors below.
  }

  return { sort_at: cursor, id: '\uffff' };
}

export function listBrowsingSessions(params: SessionsListParams = {}): SessionsResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    // Include the full day
    conditions.push('started_at < ?');
    const nextDay = new Date(params.date_to);
    nextDay.setDate(nextDay.getDate() + 1);
    values.push(nextDay.toISOString().split('T')[0]);
  }
  if (params.min_messages != null) {
    conditions.push('message_count >= ?');
    values.push(params.min_messages);
  }
  if (params.max_messages != null) {
    conditions.push('message_count <= ?');
    values.push(params.max_messages);
  }
  const filterWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const filterValues = [...values];

  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM browsing_sessions ${filterWhere}`
  ).get(...filterValues) as CountResult).c;

  const cursor = decodeTimeCursor(params.cursor);
  if (cursor) {
    conditions.push('(started_at < ? OR (started_at = ? AND id < ?))');
    values.push(cursor.sort_at, cursor.sort_at, cursor.id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  values.push(limit);
  const data = (db.prepare(
    `SELECT * FROM browsing_sessions ${where} ORDER BY started_at DESC, id DESC LIMIT ?`
  ).all(...values) as BrowsingSessionDbRow[]).map(mapBrowsingSessionRow);

  // Build cursor from last item
  let nextCursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    const last = data[data.length - 1];
    if (last.started_at) {
      nextCursor = encodeTimeCursor({ sort_at: last.started_at, id: last.id });
    }
  }

  return { data, total, cursor: nextCursor };
}

export function getBrowsingSession(id: string): BrowsingSessionRow | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get(id) as BrowsingSessionDbRow | undefined;
  return row ? mapBrowsingSessionRow(row) : undefined;
}

export function getSessionChildren(parentId: string): BrowsingSessionRow[] {
  const db = getDb();
  return (db.prepare(
    'SELECT * FROM browsing_sessions WHERE parent_session_id = ? ORDER BY started_at'
  ).all(parentId) as BrowsingSessionDbRow[]).map(mapBrowsingSessionRow);
}

// --- Live sessions ---

interface LiveSessionsResult {
  data: LiveSessionRow[];
  total: number;
  cursor?: string;
}

export function listLiveSessions(params: LiveSessionsListParams = {}): LiveSessionsResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.live_status) {
    conditions.push('live_status = ?');
    values.push(params.live_status);
  }
  if (params.fidelity) {
    conditions.push('fidelity = ?');
    values.push(params.fidelity);
  }
  if (params.active_only) {
    conditions.push("COALESCE(live_status, '') IN ('live', 'active')");
  }

  const filterWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const filterValues = [...values];
  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM browsing_sessions ${filterWhere}`
  ).get(...filterValues) as CountResult).c;

  const cursor = decodeTimeCursor(params.cursor);
  if (cursor) {
    conditions.push(`(
      COALESCE(last_item_at, started_at, '') < ?
      OR (COALESCE(last_item_at, started_at, '') = ? AND id < ?)
    )`);
    values.push(cursor.sort_at, cursor.sort_at, cursor.id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit);
  const data = (db.prepare(
    `SELECT * FROM browsing_sessions
     ${where}
     ORDER BY COALESCE(last_item_at, started_at) DESC, id DESC
     LIMIT ?`
  ).all(...values) as BrowsingSessionDbRow[]).map(mapBrowsingSessionRow);

  let nextCursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    const last = data[data.length - 1];
    const sortAt = last.last_item_at ?? last.started_at;
    if (sortAt) {
      nextCursor = encodeTimeCursor({ sort_at: sortAt, id: last.id });
    }
  }

  return { data, total, cursor: nextCursor };
}

export function getLiveSession(id: string): LiveSessionRow | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get(id) as BrowsingSessionDbRow | undefined;
  return row ? mapBrowsingSessionRow(row) : undefined;
}

export function getSessionTurns(sessionId: string): LiveTurnRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM session_turns WHERE session_id = ? ORDER BY COALESCE(started_at, created_at), id'
  ).all(sessionId) as LiveTurnRow[];
}

interface LiveItemsResult {
  data: LiveItemRow[];
  total: number;
  cursor?: string;
}

export function getSessionItems(sessionId: string, params: LiveItemsListParams = {}): LiveItemsResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const conditions = ['session_id = ?'];
  const values: unknown[] = [sessionId];

  if (params.kinds && params.kinds.length > 0) {
    conditions.push(`kind IN (${params.kinds.map(() => '?').join(', ')})`);
    values.push(...params.kinds);
  }
  if (params.cursor) {
    conditions.push('id > ?');
    values.push(Number(params.cursor));
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM session_items WHERE session_id = ?`
  ).get(sessionId) as CountResult).c;

  values.push(limit);
  const data = db.prepare(
    `SELECT * FROM session_items ${where} ORDER BY id ASC LIMIT ?`
  ).all(...values) as LiveItemRow[];

  let cursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    cursor = String(data[data.length - 1].id);
  }

  return { data, total, cursor };
}

// --- Messages ---

interface MessagesResult {
  data: MessageRow[];
  total: number;
}

export function getSessionMessages(sessionId: string, params: MessagesListParams = {}): MessagesResult {
  const db = getDb();
  const offset = params.offset ?? 0;
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);

  const total = (db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE session_id = ?'
  ).get(sessionId) as CountResult).c;

  const data = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal LIMIT ? OFFSET ?'
  ).all(sessionId, limit, offset) as MessageRow[];

  return { data, total };
}

// --- Search ---

interface FtsSearchResult {
  data: Array<{
    session_id: string;
    message_id: number;
    message_ordinal: number;
    message_role: string;
    snippet: string;
  }>;
  total: number;
  cursor?: string;
}

export function searchMessages(params: SearchParams): FtsSearchResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('bs.project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('bs.agent = ?');
    values.push(params.agent);
  }

  const joinFilter = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  // Count total matches
  const countSql = `
    SELECT COUNT(*) as c
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN browsing_sessions bs ON bs.id = m.session_id
    WHERE messages_fts MATCH ? ${joinFilter}
  `;
  const total = (db.prepare(countSql).get(params.q, ...values) as CountResult).c;

  // Fetch results with snippets
  const offsetCondition = params.cursor ? `AND m.id < ?` : '';
  const offsetValues = params.cursor ? [parseInt(params.cursor, 10)] : [];

  const searchSql = `
    SELECT
      m.session_id,
      m.id as message_id,
      m.ordinal as message_ordinal,
      m.role as message_role,
      snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN browsing_sessions bs ON bs.id = m.session_id
    WHERE messages_fts MATCH ? ${joinFilter} ${offsetCondition}
    ORDER BY m.id DESC
    LIMIT ?
  `;

  const data = db.prepare(searchSql).all(
    params.q, ...values, ...offsetValues, limit
  ) as FtsSearchResult['data'];

  let cursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    cursor = String(data[data.length - 1].message_id);
  }

  return { data, total, cursor };
}

// --- Analytics ---

export function getAnalyticsSummary(params: AnalyticsParams = {}): AnalyticsSummary {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(message_count), 0) as total_messages,
      COALESCE(SUM(user_message_count), 0) as total_user_messages,
      MIN(started_at) as earliest,
      MAX(started_at) as latest
    FROM browsing_sessions ${where}
  `).get(...values) as {
    total_sessions: number;
    total_messages: number;
    total_user_messages: number;
    earliest: string | null;
    latest: string | null;
  };

  // Calculate daily averages
  let dailyAvgSessions = 0;
  let dailyAvgMessages = 0;
  if (row.earliest && row.latest) {
    const days = Math.max(1, Math.ceil(
      (new Date(row.latest).getTime() - new Date(row.earliest).getTime()) / 86_400_000
    ) + 1);
    dailyAvgSessions = Math.round((row.total_sessions / days) * 100) / 100;
    dailyAvgMessages = Math.round((row.total_messages / days) * 100) / 100;
  }

  return {
    total_sessions: row.total_sessions,
    total_messages: row.total_messages,
    total_user_messages: row.total_user_messages,
    daily_average_sessions: dailyAvgSessions,
    daily_average_messages: dailyAvgMessages,
    date_range: {
      earliest: row.earliest,
      latest: row.latest,
    },
  };
}

export function getAnalyticsActivity(params: AnalyticsParams = {}): ActivityDataPoint[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      date(started_at) as date,
      COUNT(*) as sessions,
      COALESCE(SUM(message_count), 0) as messages
    FROM browsing_sessions
    ${where}
    GROUP BY date(started_at)
    ORDER BY date
  `).all(...values) as ActivityDataPoint[];
}

export function getAnalyticsProjects(params: AnalyticsParams = {}): ProjectBreakdown[] {
  const db = getDb();
  const conditions: string[] = ['project IS NOT NULL'];
  const values: unknown[] = [];

  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  return db.prepare(`
    SELECT
      project,
      COUNT(*) as session_count,
      COALESCE(SUM(message_count), 0) as message_count
    FROM browsing_sessions
    ${where}
    GROUP BY project
    ORDER BY message_count DESC
  `).all(...values) as ProjectBreakdown[];
}

export function getAnalyticsTools(params: AnalyticsParams = {}): ToolUsageStat[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('bs.project = ?');
    values.push(params.project);
  }
  if (params.date_from) {
    conditions.push('bs.started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("bs.started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const joinFilter = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      tc.tool_name,
      tc.category,
      COUNT(*) as count
    FROM tool_calls tc
    JOIN browsing_sessions bs ON bs.id = tc.session_id
    ${joinFilter}
    GROUP BY tc.tool_name, tc.category
    ORDER BY count DESC
  `).all(...values) as ToolUsageStat[];
}

// --- Metadata ---

export function getDistinctProjects(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT project FROM browsing_sessions WHERE project IS NOT NULL ORDER BY project'
  ).all() as Array<{ project: string }>;
  return rows.map(r => r.project);
}

export function getDistinctAgents(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT agent FROM browsing_sessions ORDER BY agent'
  ).all() as Array<{ agent: string }>;
  return rows.map(r => r.agent);
}
