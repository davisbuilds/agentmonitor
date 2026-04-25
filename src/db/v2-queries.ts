import { getDb } from './connection.js';
import { config } from '../config.js';
import type {
  BrowsingSessionRow,
  BrowsingSessionDbRow,
  LiveSessionRow,
  LiveTurnRow,
  LiveItemRow,
  MessageRow,
  SessionActivity,
  SessionActivityBucket,
  PinnedMessageRow,
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
  MonitorToolStat,
  MonitorSessionRow,
  MonitorEventRow,
  SkillUsageDay,
  AnalyticsCoverage,
  HourOfWeekDataPoint,
  TopSessionStat,
  VelocityMetrics,
  AgentComparisonRow,
  UsageParams,
  UsageCoverage,
  UsageSourceBreakdown,
  UsageSummary,
  UsageDailyPoint,
  UsageProjectBreakdown,
  UsageModelBreakdown,
  UsageAgentBreakdown,
  UsageTopSessionRow,
  MonitorSessionsParams,
  MonitorEventsParams,
  InsightRow,
  InsightDbRow,
  InsightInputSnapshot,
  InsightsListParams,
  GenerateInsightParams,
  SearchResultRow,
  PinsListParams,
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
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);

  const total = (db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE session_id = ?'
  ).get(sessionId) as CountResult).c;

  if (params.around_ordinal != null) {
    const beforeCount = Math.floor((limit - 1) / 2);
    const maxStartOrdinal = Math.max(0, total - limit);
    const requestedStartOrdinal = Math.max(0, params.around_ordinal - beforeCount);
    const startOrdinal = Math.min(requestedStartOrdinal, maxStartOrdinal);
    const data = db.prepare(
      'SELECT * FROM messages WHERE session_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?'
    ).all(sessionId, startOrdinal, limit) as MessageRow[];

    return { data, total };
  }

  const offset = Math.max(params.offset ?? 0, 0);
  const data = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal LIMIT ? OFFSET ?'
  ).all(sessionId, limit, offset) as MessageRow[];

  return { data, total };
}

export function getSessionActivity(sessionId: string): SessionActivity {
  const db = getDb();
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_messages,
      COUNT(timestamp) as timestamped_messages,
      MIN(timestamp) as first_timestamp,
      MAX(timestamp) as last_timestamp
    FROM messages
    WHERE session_id = ?
  `).get(sessionId) as {
    total_messages: number;
    timestamped_messages: number;
    first_timestamp: string | null;
    last_timestamp: string | null;
  };

  if (summary.total_messages === 0) {
    return {
      bucket_count: 0,
      total_messages: 0,
      first_timestamp: null,
      last_timestamp: null,
      timestamped_messages: 0,
      untimestamped_messages: 0,
      navigation_basis: 'ordinal',
      data: [],
    };
  }

  const bucketCount = Math.min(40, Math.max(8, summary.total_messages));
  const rows = db.prepare(`
    WITH ordered AS (
      SELECT
        ordinal,
        role,
        timestamp,
        ROW_NUMBER() OVER (ORDER BY ordinal) - 1 as seq,
        COUNT(*) OVER () as total_count
      FROM messages
      WHERE session_id = ?
    ),
    bucketed AS (
      SELECT
        MIN(CAST((seq * ?) / total_count AS INTEGER), ? - 1) as bucket_index,
        ordinal,
        role,
        timestamp
      FROM ordered
    )
    SELECT
      bucket_index,
      MIN(ordinal) as start_ordinal,
      MAX(ordinal) as end_ordinal,
      COUNT(*) as message_count,
      COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) as user_message_count,
      COALESCE(SUM(CASE WHEN role != 'user' THEN 1 ELSE 0 END), 0) as assistant_message_count,
      MIN(timestamp) as first_timestamp,
      MAX(timestamp) as last_timestamp
    FROM bucketed
    GROUP BY bucket_index
    ORDER BY bucket_index
  `).all(sessionId, bucketCount, bucketCount) as SessionActivityBucket[];

  const rowByIndex = new Map(rows.map(row => [row.bucket_index, row]));
  const data: SessionActivityBucket[] = [];
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
    data.push(rowByIndex.get(bucketIndex) ?? {
      bucket_index: bucketIndex,
      start_ordinal: null,
      end_ordinal: null,
      message_count: 0,
      user_message_count: 0,
      assistant_message_count: 0,
      first_timestamp: null,
      last_timestamp: null,
    });
  }

  const untimestampedMessages = Math.max(0, summary.total_messages - summary.timestamped_messages);
  const navigationBasis = summary.timestamped_messages === 0
    ? 'ordinal'
    : untimestampedMessages === 0
      ? 'timestamp'
      : 'mixed';

  return {
    bucket_count: bucketCount,
    total_messages: summary.total_messages,
    first_timestamp: summary.first_timestamp,
    last_timestamp: summary.last_timestamp,
    timestamped_messages: summary.timestamped_messages,
    untimestamped_messages: untimestampedMessages,
    navigation_basis: navigationBasis,
    data,
  };
}

interface PinnedMessageRecord extends PinnedMessageRow {
  message_ordinal: number;
}

interface PinMessageLookup {
  id: number;
  ordinal: number;
}

export function listPinnedMessages(params: PinsListParams & { session_id?: string } = {}): PinnedMessageRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.session_id) {
    conditions.push('p.session_id = ?');
    values.push(params.session_id);
  } else if (params.project) {
    conditions.push('bs.project = ?');
    values.push(params.project);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      p.id,
      p.session_id,
      COALESCE(m.id, p.message_id) as message_id,
      p.message_ordinal,
      m.role,
      m.content,
      m.timestamp as message_timestamp,
      p.created_at,
      bs.project as session_project,
      bs.agent as session_agent,
      bs.first_message as session_first_message
    FROM pinned_messages p
    LEFT JOIN messages m
      ON m.session_id = p.session_id
     AND m.ordinal = p.message_ordinal
    LEFT JOIN browsing_sessions bs
      ON bs.id = p.session_id
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
  `).all(...values) as PinnedMessageRecord[];
}

function getPinMessageLookup(sessionId: string, messageId: number): PinMessageLookup | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT id, ordinal
    FROM messages
    WHERE session_id = ? AND id = ?
  `).get(sessionId, messageId) as PinMessageLookup | undefined;
}

export function pinMessage(sessionId: string, messageId: number): PinnedMessageRow | undefined {
  const db = getDb();
  const message = getPinMessageLookup(sessionId, messageId);
  if (!message) return undefined;

  db.prepare(`
    INSERT INTO pinned_messages (session_id, message_id, message_ordinal)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, message_ordinal)
    DO UPDATE SET message_id = excluded.message_id
  `).run(sessionId, message.id, message.ordinal);

  return db.prepare(`
    SELECT
      p.id,
      p.session_id,
      m.id as message_id,
      p.message_ordinal,
      m.role,
      m.content,
      m.timestamp as message_timestamp,
      p.created_at,
      bs.project as session_project,
      bs.agent as session_agent,
      bs.first_message as session_first_message
    FROM pinned_messages p
    LEFT JOIN messages m
      ON m.session_id = p.session_id
     AND m.ordinal = p.message_ordinal
    LEFT JOIN browsing_sessions bs
      ON bs.id = p.session_id
    WHERE p.session_id = ? AND p.message_ordinal = ?
  `).get(sessionId, message.ordinal) as PinnedMessageRecord | undefined;
}

export function unpinMessage(sessionId: string, messageId: number): { removed: boolean; message_ordinal: number | null } {
  const db = getDb();
  const message = getPinMessageLookup(sessionId, messageId);

  if (message) {
    const result = db.prepare(`
      DELETE FROM pinned_messages
      WHERE session_id = ? AND message_ordinal = ?
    `).run(sessionId, message.ordinal);
    return { removed: result.changes > 0, message_ordinal: message.ordinal };
  }

  const storedPin = db.prepare(`
    SELECT message_ordinal
    FROM pinned_messages
    WHERE session_id = ? AND message_id = ?
  `).get(sessionId, messageId) as { message_ordinal: number } | undefined;

  const result = db.prepare(`
    DELETE FROM pinned_messages
    WHERE session_id = ? AND message_id = ?
  `).run(sessionId, messageId);
  return { removed: result.changes > 0, message_ordinal: storedPin?.message_ordinal ?? null };
}

// --- Search ---

interface FtsSearchResult {
  data: SearchResultRow[];
  total: number;
  cursor?: string;
}

type FtsSearchBaseRow = FtsSearchResult['data'][number];

type FtsSearchRow = FtsSearchBaseRow & {
  search_rank?: number;
};

interface RelevanceCursor {
  rank: number;
  message_id: number;
}

function decodeRelevanceCursor(cursor: string | undefined): RelevanceCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Partial<RelevanceCursor>;
    if (typeof parsed.rank === 'number' && typeof parsed.message_id === 'number') {
      return {
        rank: parsed.rank,
        message_id: parsed.message_id,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function encodeRelevanceCursor(cursor: RelevanceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

export function searchMessages(params: SearchParams): FtsSearchResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const sort = params.sort === 'relevance' ? 'relevance' : 'recent';

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

  if (sort === 'relevance') {
    const cursorState = decodeRelevanceCursor(params.cursor);
    const offsetCondition = cursorState
      ? `AND (
          bm25(messages_fts) > ?
          OR (bm25(messages_fts) = ? AND m.id < ?)
        )`
      : '';
    const offsetValues = cursorState
      ? [cursorState.rank, cursorState.rank, cursorState.message_id]
      : [];

    const searchSql = `
      SELECT
        m.session_id,
        m.id as message_id,
        m.ordinal as message_ordinal,
        m.role as message_role,
        snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet,
        bs.project as session_project,
        bs.agent as session_agent,
        bs.started_at as session_started_at,
        bs.ended_at as session_ended_at,
        bs.first_message as session_first_message,
        bm25(messages_fts) as search_rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN browsing_sessions bs ON bs.id = m.session_id
      WHERE messages_fts MATCH ? ${joinFilter} ${offsetCondition}
      ORDER BY search_rank ASC, m.id DESC
      LIMIT ?
    `;

    const rows = db.prepare(searchSql).all(
      params.q, ...values, ...offsetValues, limit,
    ) as FtsSearchRow[];

    let cursor: string | undefined;
    if (rows.length === limit && rows.length > 0) {
      const last = rows[rows.length - 1];
      if (typeof last?.search_rank === 'number') {
        cursor = encodeRelevanceCursor({
          rank: last.search_rank,
          message_id: last.message_id,
        });
      }
    }

    return {
      data: rows.map(({ search_rank: _searchRank, ...row }) => row as FtsSearchBaseRow),
      total,
      cursor,
    };
  }

  const recentCursor = params.cursor ? parseInt(params.cursor, 10) : null;
  const offsetCondition = Number.isFinite(recentCursor) ? `AND m.id < ?` : '';
  const offsetValues = Number.isFinite(recentCursor) ? [recentCursor] : [];

  const searchSql = `
    SELECT
      m.session_id,
      m.id as message_id,
      m.ordinal as message_ordinal,
      m.role as message_role,
      snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet,
      bs.project as session_project,
      bs.agent as session_agent,
      bs.started_at as session_started_at,
      bs.ended_at as session_ended_at,
      bs.first_message as session_first_message
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN browsing_sessions bs ON bs.id = m.session_id
    WHERE messages_fts MATCH ? ${joinFilter} ${offsetCondition}
    ORDER BY m.id DESC
    LIMIT ?
  `;

  const data = db.prepare(searchSql).all(
    params.q, ...values, ...offsetValues, limit,
  ) as FtsSearchResult['data'];

  let cursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    cursor = String(data[data.length - 1].message_id);
  }

  return { data, total, cursor };
}

// --- Analytics ---
type AnalyticsCoverageScope = AnalyticsCoverage['metric_scope'];

interface AnalyticsFilterState {
  conditions: string[];
  values: unknown[];
  where: string;
}

function qualifyColumn(alias: string | undefined, column: string): string {
  return alias ? `${alias}.${column}` : column;
}

function buildAnalyticsFilterState(params: AnalyticsParams = {}, alias?: string): AnalyticsFilterState {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push(`${qualifyColumn(alias, 'project')} = ?`);
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push(`${qualifyColumn(alias, 'agent')} = ?`);
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push(`${qualifyColumn(alias, 'started_at')} >= ?`);
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push(`${qualifyColumn(alias, 'started_at')} < date(?, '+1 day')`);
    values.push(params.date_to);
  }

  return {
    conditions,
    values,
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
  };
}

function analyticsFidelityExpr(alias?: string): string {
  const fidelityColumn = qualifyColumn(alias, 'fidelity');
  const integrationModeColumn = qualifyColumn(alias, 'integration_mode');
  return `CASE
    WHEN ${fidelityColumn} = 'full' THEN 'full'
    WHEN ${fidelityColumn} = 'summary' THEN 'summary'
    WHEN ${integrationModeColumn} = 'claude-jsonl' THEN 'full'
    ELSE 'unknown'
  END`;
}

function analyticsCapabilityExpr(
  capability: 'history' | 'search' | 'tool_analytics' | 'live_items',
  alias?: string,
): string {
  const capabilitiesColumn = qualifyColumn(alias, 'capabilities_json');
  const fidelityColumn = qualifyColumn(alias, 'fidelity');
  const integrationModeColumn = qualifyColumn(alias, 'integration_mode');
  return `COALESCE(
    json_extract(${capabilitiesColumn}, '$.${capability}'),
    CASE
      WHEN ${integrationModeColumn} = 'claude-jsonl' OR ${fidelityColumn} = 'full' THEN 'full'
      WHEN ${fidelityColumn} = 'summary' THEN 'none'
      ELSE 'unknown'
    END
  )`;
}

function toolAnalyticsCapableCondition(alias?: string): string {
  return `${analyticsCapabilityExpr('tool_analytics', alias)} IN ('summary', 'full')`;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function inclusiveDateSpanDays(earliest: string | null, latest: string | null): number {
  if (!earliest || !latest) return 0;
  const earliestDate = new Date(`${earliest.slice(0, 10)}T00:00:00.000Z`);
  const latestDate = new Date(`${latest.slice(0, 10)}T00:00:00.000Z`);
  return Math.max(1, Math.round(
    (latestDate.getTime() - earliestDate.getTime()) / 86_400_000
  ) + 1);
}

function enumerateDateRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }

  const dates: string[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function parseJsonString(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function extractCanonicalCodexSessionId(sessionId: string): string {
  const match = sessionId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? sessionId;
}

function extractCodexCommandFromInputJson(inputJson: string | null): string | undefined {
  const parsed = parseJsonString(inputJson);
  if (typeof parsed === 'string') return parsed;

  const record = asPlainObject(parsed);
  if (!record) return undefined;

  const cmd = record['cmd'];
  if (typeof cmd === 'string') return cmd;

  const command = record['command'];
  if (typeof command === 'string') return command;

  return undefined;
}

function extractCodexCommandFromEventMetadata(metadataJson: string | null): string | undefined {
  const parsed = parseJsonString(metadataJson);
  const record = asPlainObject(parsed);
  if (!record) return undefined;

  const argumentsValue = record['arguments'];
  if (typeof argumentsValue === 'string') return argumentsValue;

  const argumentsRecord = asPlainObject(argumentsValue);
  if (argumentsRecord) {
    const cmd = argumentsRecord['cmd'];
    if (typeof cmd === 'string') return cmd;

    const command = argumentsRecord['command'];
    if (typeof command === 'string') return command;
  }

  const input = record['input'];
  if (typeof input === 'string') return input;

  return undefined;
}

function extractCodexSkillNamesFromCommand(command: string): string[] {
  const skillNames = new Set<string>();
  const pattern = /(?:^|[\s'"])(~?\/[^\s'"]*\/([^/\s'"]+)\/SKILL\.md)(?=$|[\s'"])/g;

  for (const match of command.matchAll(pattern)) {
    const skillName = match[2]?.trim();
    if (skillName) skillNames.add(skillName);
  }

  return [...skillNames];
}

function isDateWithinRange(date: string, params: AnalyticsParams): boolean {
  if (params.date_from && date < params.date_from) return false;
  if (params.date_to && date > params.date_to) return false;
  return true;
}

interface SkillAccumulator {
  total: number;
  skills: Map<string, number>;
}

function addSkillCount(days: Map<string, SkillAccumulator>, date: string, skillName: string): void {
  const existing = days.get(date) ?? { total: 0, skills: new Map<string, number>() };
  existing.total += 1;
  existing.skills.set(skillName, (existing.skills.get(skillName) ?? 0) + 1);
  days.set(date, existing);
}

export function getAnalyticsCoverage(
  params: AnalyticsParams = {},
  scope: AnalyticsCoverageScope = 'all_sessions',
): AnalyticsCoverage {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);
  const includedCondition = scope === 'tool_analytics_capable' ? toolAnalyticsCapableCondition() : '1 = 1';
  const fidelityExpr = analyticsFidelityExpr();
  const historyExpr = analyticsCapabilityExpr('history');
  const searchExpr = analyticsCapabilityExpr('search');
  const toolAnalyticsExpr = analyticsCapabilityExpr('tool_analytics');
  const liveItemsExpr = analyticsCapabilityExpr('live_items');

  const row = db.prepare(`
    SELECT
      COUNT(*) as matching_sessions,
      COALESCE(SUM(CASE WHEN ${includedCondition} THEN 1 ELSE 0 END), 0) as included_sessions,
      COALESCE(SUM(CASE WHEN ${fidelityExpr} = 'full' THEN 1 ELSE 0 END), 0) as fidelity_full,
      COALESCE(SUM(CASE WHEN ${fidelityExpr} = 'summary' THEN 1 ELSE 0 END), 0) as fidelity_summary,
      COALESCE(SUM(CASE WHEN ${fidelityExpr} = 'unknown' THEN 1 ELSE 0 END), 0) as fidelity_unknown,
      COALESCE(SUM(CASE WHEN ${historyExpr} = 'full' THEN 1 ELSE 0 END), 0) as history_full,
      COALESCE(SUM(CASE WHEN ${historyExpr} = 'summary' THEN 1 ELSE 0 END), 0) as history_summary,
      COALESCE(SUM(CASE WHEN ${historyExpr} = 'none' THEN 1 ELSE 0 END), 0) as history_none,
      COALESCE(SUM(CASE WHEN ${historyExpr} = 'unknown' THEN 1 ELSE 0 END), 0) as history_unknown,
      COALESCE(SUM(CASE WHEN ${searchExpr} = 'full' THEN 1 ELSE 0 END), 0) as search_full,
      COALESCE(SUM(CASE WHEN ${searchExpr} = 'summary' THEN 1 ELSE 0 END), 0) as search_summary,
      COALESCE(SUM(CASE WHEN ${searchExpr} = 'none' THEN 1 ELSE 0 END), 0) as search_none,
      COALESCE(SUM(CASE WHEN ${searchExpr} = 'unknown' THEN 1 ELSE 0 END), 0) as search_unknown,
      COALESCE(SUM(CASE WHEN ${toolAnalyticsExpr} = 'full' THEN 1 ELSE 0 END), 0) as tool_analytics_full,
      COALESCE(SUM(CASE WHEN ${toolAnalyticsExpr} = 'summary' THEN 1 ELSE 0 END), 0) as tool_analytics_summary,
      COALESCE(SUM(CASE WHEN ${toolAnalyticsExpr} = 'none' THEN 1 ELSE 0 END), 0) as tool_analytics_none,
      COALESCE(SUM(CASE WHEN ${toolAnalyticsExpr} = 'unknown' THEN 1 ELSE 0 END), 0) as tool_analytics_unknown,
      COALESCE(SUM(CASE WHEN ${liveItemsExpr} = 'full' THEN 1 ELSE 0 END), 0) as live_items_full,
      COALESCE(SUM(CASE WHEN ${liveItemsExpr} = 'summary' THEN 1 ELSE 0 END), 0) as live_items_summary,
      COALESCE(SUM(CASE WHEN ${liveItemsExpr} = 'none' THEN 1 ELSE 0 END), 0) as live_items_none,
      COALESCE(SUM(CASE WHEN ${liveItemsExpr} = 'unknown' THEN 1 ELSE 0 END), 0) as live_items_unknown
    FROM browsing_sessions
    ${filter.where}
  `).get(...filter.values) as Record<string, number>;

  const matchingSessions = row['matching_sessions'] ?? 0;
  const includedSessions = row['included_sessions'] ?? 0;

  return {
    metric_scope: scope,
    matching_sessions: matchingSessions,
    included_sessions: includedSessions,
    excluded_sessions: Math.max(0, matchingSessions - includedSessions),
    fidelity_breakdown: {
      full: row['fidelity_full'] ?? 0,
      summary: row['fidelity_summary'] ?? 0,
      unknown: row['fidelity_unknown'] ?? 0,
    },
    capability_breakdown: {
      history: {
        full: row['history_full'] ?? 0,
        summary: row['history_summary'] ?? 0,
        none: row['history_none'] ?? 0,
        unknown: row['history_unknown'] ?? 0,
      },
      search: {
        full: row['search_full'] ?? 0,
        summary: row['search_summary'] ?? 0,
        none: row['search_none'] ?? 0,
        unknown: row['search_unknown'] ?? 0,
      },
      tool_analytics: {
        full: row['tool_analytics_full'] ?? 0,
        summary: row['tool_analytics_summary'] ?? 0,
        none: row['tool_analytics_none'] ?? 0,
        unknown: row['tool_analytics_unknown'] ?? 0,
      },
      live_items: {
        full: row['live_items_full'] ?? 0,
        summary: row['live_items_summary'] ?? 0,
        none: row['live_items_none'] ?? 0,
        unknown: row['live_items_unknown'] ?? 0,
      },
    },
    note: scope === 'tool_analytics_capable'
      ? 'Only sessions whose capability contract exposes tool analytics are included in this metric.'
      : 'This metric includes every session matching the current filters, including summary-only sessions.',
  };
}

export function getAnalyticsSummary(params: AnalyticsParams = {}): AnalyticsSummary {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(message_count), 0) as total_messages,
      COALESCE(SUM(user_message_count), 0) as total_user_messages,
      MIN(started_at) as earliest,
      MAX(started_at) as latest
    FROM browsing_sessions
    ${filter.where}
  `).get(...filter.values) as {
    total_sessions: number;
    total_messages: number;
    total_user_messages: number;
    earliest: string | null;
    latest: string | null;
  };

  let dailyAvgSessions = 0;
  let dailyAvgMessages = 0;
  if (row.earliest && row.latest) {
    const days = inclusiveDateSpanDays(row.earliest, row.latest);
    dailyAvgSessions = roundMetric(row.total_sessions / days);
    dailyAvgMessages = roundMetric(row.total_messages / days);
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
    coverage: getAnalyticsCoverage(params, 'all_sessions'),
  };
}

export function getAnalyticsActivity(params: AnalyticsParams = {}): ActivityDataPoint[] {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);

  return db.prepare(`
    SELECT
      date(started_at) as date,
      COUNT(*) as sessions,
      COALESCE(SUM(message_count), 0) as messages,
      COALESCE(SUM(user_message_count), 0) as user_messages
    FROM browsing_sessions
    ${filter.where}
    GROUP BY date(started_at)
    ORDER BY date
  `).all(...filter.values) as ActivityDataPoint[];
}

export function getAnalyticsProjects(params: AnalyticsParams = {}): ProjectBreakdown[] {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);
  const where = ['project IS NOT NULL', ...filter.conditions].join(' AND ');

  return db.prepare(`
    SELECT
      project,
      COUNT(*) as session_count,
      COALESCE(SUM(message_count), 0) as message_count,
      COALESCE(SUM(user_message_count), 0) as user_message_count
    FROM browsing_sessions
    WHERE ${where}
    GROUP BY project
    ORDER BY message_count DESC, session_count DESC, project ASC
  `).all(...filter.values) as ProjectBreakdown[];
}

export function getAnalyticsTools(params: AnalyticsParams = {}): ToolUsageStat[] {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params, 'bs');
  const where = [...filter.conditions, toolAnalyticsCapableCondition('bs')].join(' AND ');

  return db.prepare(`
    SELECT
      tc.tool_name,
      tc.category,
      COUNT(*) as count
    FROM tool_calls tc
    JOIN browsing_sessions bs ON bs.id = tc.session_id
    WHERE ${where}
    GROUP BY tc.tool_name, tc.category
    ORDER BY count DESC, tc.tool_name ASC
  `).all(...filter.values) as ToolUsageStat[];
}

export function getMonitorToolStats(params: UsageParams = {}): MonitorToolStat[] {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const where = [...filter.conditions, 'e.tool_name IS NOT NULL'].join(' AND ');

  const rows = db.prepare(`
    SELECT
      e.tool_name,
      COUNT(*) as total_calls,
      COALESCE(SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
      ROUND(CAST(COALESCE(SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END), 0) AS REAL) / COUNT(*), 4) as error_rate,
      ROUND(AVG(e.duration_ms)) as avg_duration_ms
    FROM events e
    WHERE ${where}
    GROUP BY e.tool_name
    ORDER BY total_calls DESC, e.tool_name ASC
  `).all(...filter.values) as Array<Omit<MonitorToolStat, 'by_agent'>>;

  const agentRows = db.prepare(`
    SELECT
      e.tool_name,
      e.agent_type,
      COUNT(*) as count
    FROM events e
    WHERE ${where}
    GROUP BY e.tool_name, e.agent_type
    ORDER BY e.tool_name, count DESC
  `).all(...filter.values) as Array<{ tool_name: string; agent_type: string; count: number }>;

  const byAgent = new Map<string, Record<string, number>>();
  for (const row of agentRows) {
    const next = byAgent.get(row.tool_name) ?? {};
    next[row.agent_type] = row.count;
    byAgent.set(row.tool_name, next);
  }

  return rows.map(row => ({
    ...row,
    by_agent: byAgent.get(row.tool_name) ?? {},
  }));
}

function updateMonitorSessionStatuses(timeoutMinutes: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET status = 'idle'
    WHERE status = 'active'
    AND last_event_at < datetime('now', ? || ' minutes')
  `).run(`-${timeoutMinutes}`);

  db.prepare(`
    UPDATE sessions SET status = 'ended', ended_at = datetime('now')
    WHERE status = 'idle'
    AND last_event_at < datetime('now', ? || ' minutes')
  `).run(`-${timeoutMinutes * 2}`);
}

export function listMonitorSessions(params: MonitorSessionsParams = {}): { sessions: MonitorSessionRow[]; total: number } {
  const db = getDb();
  updateMonitorSessionStatuses(config.sessionTimeoutMinutes);

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    conditions.push('s.status = ?');
    values.push(params.status);
  }
  if (params.exclude_status) {
    conditions.push('s.status != ?');
    values.push(params.exclude_status);
  }
  if (params.project) {
    conditions.push('s.project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('s.agent_type = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('datetime(s.last_event_at) >= datetime(?)');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push(`datetime(s.last_event_at) < datetime(?, '+1 day')`);
    values.push(params.date_to);
  }

  const requestedLimit = Number.isFinite(params.limit) ? Math.trunc(params.limit as number) : 50;
  const applyLimit = requestedLimit > 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const queryValues = applyLimit ? [...values, requestedLimit] : values;

  const sessions = db.prepare(`
    SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
      COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
      COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out,
      COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) as total_cost_usd,
      COALESCE((SELECT COUNT(DISTINCT json_extract(e.metadata, '$.file_path')) FROM events e WHERE e.session_id = s.id AND json_valid(e.metadata) = 1 AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin') AND json_extract(e.metadata, '$.file_path') IS NOT NULL), 0) as files_edited,
      COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_added') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_valid(e.metadata) = 1 AND json_extract(e.metadata, '$.lines_added') IS NOT NULL), 0) as lines_added,
      COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_removed') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_valid(e.metadata) = 1 AND json_extract(e.metadata, '$.lines_removed') IS NOT NULL), 0) as lines_removed
    FROM sessions s
    ${where}
    ORDER BY
      CASE s.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
      datetime(s.last_event_at) DESC,
      s.id DESC
    ${applyLimit ? 'LIMIT ?' : ''}
  `).all(...queryValues) as MonitorSessionRow[];

  return { sessions, total: sessions.length };
}

export function listMonitorEvents(params: MonitorEventsParams = {}): { events: MonitorEventRow[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.agent) {
    conditions.push('agent_type = ?');
    values.push(params.agent);
  }
  if (params.event_type) {
    conditions.push('event_type = ?');
    values.push(params.event_type);
  }
  if (params.tool_name) {
    conditions.push('tool_name = ?');
    values.push(params.tool_name);
  }
  if (params.session_id) {
    conditions.push('session_id = ?');
    values.push(params.session_id);
  }
  if (params.branch) {
    conditions.push('branch = ?');
    values.push(params.branch);
  }
  if (params.model) {
    conditions.push('model = ?');
    values.push(params.model);
  }
  if (params.source) {
    conditions.push('source = ?');
    values.push(params.source);
  }
  if (params.since) {
    conditions.push('created_at >= datetime(?)');
    values.push(params.since);
  }
  if (params.until) {
    conditions.push('created_at <= datetime(?)');
    values.push(params.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const total = (db.prepare(`SELECT COUNT(*) as c FROM events ${where}`).get(...values) as CountResult).c;
  const events = db.prepare(`
    SELECT * FROM events ${where}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as MonitorEventRow[];

  return { events, total };
}

export function getAnalyticsSkillsDaily(params: AnalyticsParams = {}): SkillUsageDay[] {
  const db = getDb();
  const days = new Map<string, SkillAccumulator>();

  const explicitSkillRows = db.prepare(`
    SELECT
      COALESCE(m.timestamp, bs.started_at) as timestamp,
      bs.project,
      bs.agent,
      tc.input_json
    FROM tool_calls tc
    JOIN browsing_sessions bs ON bs.id = tc.session_id
    LEFT JOIN messages m ON m.id = tc.message_id
    WHERE tc.tool_name = 'Skill'
      AND tc.input_json IS NOT NULL
  `).all() as Array<{
    timestamp: string | null;
    project: string | null;
    agent: string;
    input_json: string | null;
  }>;

  for (const row of explicitSkillRows) {
    if (params.project && row.project !== params.project) continue;
    if (params.agent && row.agent !== params.agent) continue;
    if (!row.timestamp) continue;

    const parsed = asPlainObject(parseJsonString(row.input_json));
    const skillName = typeof parsed?.['skill'] === 'string' ? parsed['skill'] : undefined;
    if (!skillName) continue;

    const date = row.timestamp.slice(0, 10);
    if (!isDateWithinRange(date, params)) continue;
    addSkillCount(days, date, skillName);
  }

  if (!params.agent || params.agent === 'codex') {
    const codexEventRows = db.prepare(`
      SELECT
        session_id,
        project,
        COALESCE(client_timestamp, created_at) as timestamp,
        metadata
      FROM events
      WHERE agent_type = 'codex'
        AND event_type = 'tool_use'
        AND tool_name = 'exec_command'
        AND metadata LIKE '%SKILL.md%'
    `).all() as Array<{
      session_id: string;
      project: string | null;
      timestamp: string | null;
      metadata: string | null;
    }>;

    const codexSessionsWithEvents = new Set<string>();

    for (const row of codexEventRows) {
      codexSessionsWithEvents.add(extractCanonicalCodexSessionId(row.session_id));
      if (params.project && row.project !== params.project) continue;
      if (!row.timestamp) continue;

      const command = extractCodexCommandFromEventMetadata(row.metadata);
      if (!command) continue;

      const skillNames = extractCodexSkillNamesFromCommand(command);
      if (skillNames.length === 0) continue;

      const date = row.timestamp.slice(0, 10);
      if (!isDateWithinRange(date, params)) continue;

      for (const skillName of skillNames) {
        addSkillCount(days, date, skillName);
      }
    }

    const codexJsonlRows = db.prepare(`
      SELECT
        bs.id as session_id,
        bs.project,
        COALESCE(m.timestamp, bs.started_at) as timestamp,
        tc.input_json
      FROM tool_calls tc
      JOIN browsing_sessions bs ON bs.id = tc.session_id
      LEFT JOIN messages m ON m.id = tc.message_id
      WHERE bs.agent = 'codex'
        AND bs.integration_mode = 'codex-jsonl'
        AND tc.tool_name = 'exec_command'
        AND tc.input_json IS NOT NULL
        AND tc.input_json LIKE '%SKILL.md%'
    `).all() as Array<{
      session_id: string;
      project: string | null;
      timestamp: string | null;
      input_json: string | null;
    }>;

    for (const row of codexJsonlRows) {
      const canonicalSessionId = extractCanonicalCodexSessionId(row.session_id);
      if (codexSessionsWithEvents.has(canonicalSessionId)) continue;
      if (params.project && row.project !== params.project) continue;
      if (!row.timestamp) continue;

      const command = extractCodexCommandFromInputJson(row.input_json);
      if (!command) continue;

      const skillNames = extractCodexSkillNamesFromCommand(command);
      if (skillNames.length === 0) continue;

      const date = row.timestamp.slice(0, 10);
      if (!isDateWithinRange(date, params)) continue;

      for (const skillName of skillNames) {
        addSkillCount(days, date, skillName);
      }
    }
  }

  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, info]) => ({
      date,
      total: info.total,
      skills: [...info.skills.entries()]
        .map(([skill_name, count]) => ({ skill_name, count }))
        .sort((left, right) => right.count - left.count || left.skill_name.localeCompare(right.skill_name)),
    }));
}

export function getAnalyticsHourOfWeek(params: AnalyticsParams = {}): HourOfWeekDataPoint[] {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);
  const rows = db.prepare(`
    SELECT
      ((CAST(strftime('%w', started_at) AS INTEGER) + 6) % 7) as day_of_week,
      CAST(strftime('%H', started_at) AS INTEGER) as hour_of_day,
      COUNT(*) as session_count,
      COALESCE(SUM(message_count), 0) as message_count,
      COALESCE(SUM(user_message_count), 0) as user_message_count
    FROM browsing_sessions
    ${filter.where}
    GROUP BY day_of_week, hour_of_day
    ORDER BY day_of_week, hour_of_day
  `).all(...filter.values) as HourOfWeekDataPoint[];

  const byBucket = new Map(rows.map(row => [`${row.day_of_week}:${row.hour_of_day}`, row]));
  const grid: HourOfWeekDataPoint[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      grid.push(byBucket.get(`${day}:${hour}`) ?? {
        day_of_week: day,
        hour_of_day: hour,
        session_count: 0,
        message_count: 0,
        user_message_count: 0,
      });
    }
  }
  return grid;
}

export function getAnalyticsTopSessions(params: AnalyticsParams = {}): TopSessionStat[] {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params, 'bs');
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);

  return db.prepare(`
    SELECT
      bs.id,
      bs.project,
      bs.agent,
      bs.started_at,
      bs.ended_at,
      bs.message_count,
      bs.user_message_count,
      COALESCE(tc.tool_call_count, 0) as tool_call_count,
      bs.fidelity
    FROM browsing_sessions bs
    LEFT JOIN (
      SELECT session_id, COUNT(*) as tool_call_count
      FROM tool_calls
      GROUP BY session_id
    ) tc ON tc.session_id = bs.id
    ${filter.where}
    ORDER BY bs.message_count DESC, bs.started_at DESC, bs.id DESC
    LIMIT ?
  `).all(...filter.values, limit) as TopSessionStat[];
}

export function getAnalyticsVelocity(params: AnalyticsParams = {}): VelocityMetrics {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(message_count), 0) as total_messages,
      COALESCE(SUM(user_message_count), 0) as total_user_messages,
      COUNT(DISTINCT date(started_at)) as active_days,
      MIN(started_at) as earliest,
      MAX(started_at) as latest
    FROM browsing_sessions
    ${filter.where}
  `).get(...filter.values) as {
    total_sessions: number;
    total_messages: number;
    total_user_messages: number;
    active_days: number;
    earliest: string | null;
    latest: string | null;
  };

  const spanDays = inclusiveDateSpanDays(row.earliest, row.latest);

  const safeActiveDays = Math.max(row.active_days, 1);
  const safeSpanDays = Math.max(spanDays, 1);
  const safeSessions = Math.max(row.total_sessions, 1);

  return {
    total_sessions: row.total_sessions,
    total_messages: row.total_messages,
    total_user_messages: row.total_user_messages,
    active_days: row.total_sessions > 0 ? row.active_days : 0,
    span_days: spanDays,
    sessions_per_active_day: row.total_sessions > 0 ? roundMetric(row.total_sessions / safeActiveDays) : 0,
    messages_per_active_day: row.total_sessions > 0 ? roundMetric(row.total_messages / safeActiveDays) : 0,
    sessions_per_calendar_day: row.total_sessions > 0 ? roundMetric(row.total_sessions / safeSpanDays) : 0,
    messages_per_calendar_day: row.total_sessions > 0 ? roundMetric(row.total_messages / safeSpanDays) : 0,
    average_messages_per_session: row.total_sessions > 0 ? roundMetric(row.total_messages / safeSessions) : 0,
    average_user_messages_per_session: row.total_sessions > 0 ? roundMetric(row.total_user_messages / safeSessions) : 0,
    coverage: getAnalyticsCoverage(params, 'all_sessions'),
  };
}

export function getAnalyticsAgents(params: AnalyticsParams = {}): AgentComparisonRow[] {
  const db = getDb();
  const filter = buildAnalyticsFilterState(params);
  const fidelityExpr = analyticsFidelityExpr();

  return db.prepare(`
    SELECT
      agent,
      COUNT(*) as session_count,
      COALESCE(SUM(message_count), 0) as message_count,
      COALESCE(SUM(user_message_count), 0) as user_message_count,
      ROUND(COALESCE(1.0 * SUM(message_count) / NULLIF(COUNT(*), 0), 0), 2) as average_messages_per_session,
      COALESCE(SUM(CASE WHEN ${fidelityExpr} = 'full' THEN 1 ELSE 0 END), 0) as full_fidelity_sessions,
      COALESCE(SUM(CASE WHEN ${fidelityExpr} = 'summary' THEN 1 ELSE 0 END), 0) as summary_fidelity_sessions,
      COALESCE(SUM(CASE WHEN ${toolAnalyticsCapableCondition()} THEN 1 ELSE 0 END), 0) as tool_analytics_capable_sessions,
      MIN(started_at) as first_started_at,
      MAX(started_at) as last_started_at
    FROM browsing_sessions
    ${filter.where}
    GROUP BY agent
    ORDER BY message_count DESC, session_count DESC, agent ASC
  `).all(...filter.values) as AgentComparisonRow[];
}

// --- Usage ---

interface UsageFilterState {
  conditions: string[];
  values: unknown[];
  where: string;
}

function usageTimestampExpr(alias = 'e'): string {
  return `COALESCE(${qualifyColumn(alias, 'client_timestamp')}, ${qualifyColumn(alias, 'created_at')})`;
}

function usageProjectExpr(alias = 'e'): string {
  return `COALESCE(NULLIF(${qualifyColumn(alias, 'project')}, ''), 'unknown')`;
}

function usageAgentExpr(alias = 'e'): string {
  return qualifyColumn(alias, 'agent_type');
}

function usageModelExpr(alias = 'e'): string {
  return `COALESCE(NULLIF(${qualifyColumn(alias, 'model')}, ''), 'unknown')`;
}

function usageMetricsCondition(alias = 'e'): string {
  return `(
    COALESCE(${qualifyColumn(alias, 'cost_usd')}, 0) > 0
    OR COALESCE(${qualifyColumn(alias, 'tokens_in')}, 0) > 0
    OR COALESCE(${qualifyColumn(alias, 'tokens_out')}, 0) > 0
    OR COALESCE(${qualifyColumn(alias, 'cache_read_tokens')}, 0) > 0
    OR COALESCE(${qualifyColumn(alias, 'cache_write_tokens')}, 0) > 0
  )`;
}

function buildUsageFilterState(params: UsageParams = {}, alias = 'e'): UsageFilterState {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const timestampExpr = usageTimestampExpr(alias);

  if (params.project) {
    conditions.push(`${usageProjectExpr(alias)} = ?`);
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push(`${usageAgentExpr(alias)} = ?`);
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push(`datetime(${timestampExpr}) >= datetime(?)`);
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push(`datetime(${timestampExpr}) < datetime(?, '+1 day')`);
    values.push(params.date_to);
  }

  return {
    conditions,
    values,
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
  };
}

function resolveUsageDateBounds(
  params: UsageParams,
  earliest: string | null,
  latest: string | null,
): { from: string | null; to: string | null } {
  const from = params.date_from ?? earliest?.slice(0, 10) ?? null;
  const to = params.date_to ?? latest?.slice(0, 10) ?? null;
  if (!from || !to || from > to) {
    return { from: null, to: null };
  }
  return { from, to };
}

export function getUsageCoverage(params: UsageParams = {}): UsageCoverage {
  const db = getDb();
  const filter = buildUsageFilterState(params);
  const metricsCondition = usageMetricsCondition('e');

  const summary = db.prepare(`
    SELECT
      COUNT(*) as matching_events,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN 1 ELSE 0 END), 0) as usage_events,
      COUNT(DISTINCT e.session_id) as matching_sessions,
      COUNT(DISTINCT CASE WHEN ${metricsCondition} THEN e.session_id END) as usage_sessions
    FROM events e
    ${filter.where}
  `).get(...filter.values) as {
    matching_events: number;
    usage_events: number;
    matching_sessions: number;
    usage_sessions: number;
  };

  const sourceBreakdown = db.prepare(`
    SELECT
      COALESCE(NULLIF(e.source, ''), 'api') as source,
      COUNT(*) as event_count,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN 1 ELSE 0 END), 0) as usage_event_count,
      COUNT(DISTINCT CASE WHEN ${metricsCondition} THEN e.session_id END) as session_count,
      ROUND(COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.cost_usd ELSE 0 END), 0), 6) as cost_usd,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.tokens_in ELSE 0 END), 0) as input_tokens,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.tokens_out ELSE 0 END), 0) as output_tokens,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.cache_read_tokens ELSE 0 END), 0) as cache_read_tokens,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.cache_write_tokens ELSE 0 END), 0) as cache_write_tokens
    FROM events e
    ${filter.where}
    GROUP BY source
    ORDER BY source ASC
  `).all(...filter.values) as UsageSourceBreakdown[];

  return {
    metric_scope: 'event_usage',
    matching_events: summary.matching_events,
    usage_events: summary.usage_events,
    missing_usage_events: Math.max(0, summary.matching_events - summary.usage_events),
    matching_sessions: summary.matching_sessions,
    usage_sessions: summary.usage_sessions,
    sources_with_usage: sourceBreakdown.filter(row => row.usage_event_count > 0).length,
    source_breakdown: sourceBreakdown,
    note: 'Usage is derived from ingested events with cost or token data. Sessions without usage-bearing events are excluded from totals but still reflected in coverage.',
  };
}

export function getUsageSummary(params: UsageParams = {}): UsageSummary {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const usageWhere = [...filter.conditions, usageMetricsCondition('e')].join(' AND ');
  const timestampExpr = usageTimestampExpr('e');

  const row = db.prepare(`
    SELECT
      ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as total_cost_usd,
      COALESCE(SUM(e.tokens_in), 0) as total_input_tokens,
      COALESCE(SUM(e.tokens_out), 0) as total_output_tokens,
      COALESCE(SUM(e.cache_read_tokens), 0) as total_cache_read_tokens,
      COALESCE(SUM(e.cache_write_tokens), 0) as total_cache_write_tokens,
      COUNT(*) as total_usage_events,
      COUNT(DISTINCT e.session_id) as total_sessions,
      COUNT(DISTINCT date(${timestampExpr})) as active_days,
      MIN(${timestampExpr}) as earliest,
      MAX(${timestampExpr}) as latest
    FROM events e
    WHERE ${usageWhere}
  `).get(...filter.values) as {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_write_tokens: number;
    total_usage_events: number;
    total_sessions: number;
    active_days: number;
    earliest: string | null;
    latest: string | null;
  };

  const peakDay = db.prepare(`
    SELECT
      date(${timestampExpr}) as date,
      ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd
    FROM events e
    WHERE ${usageWhere}
    GROUP BY date(${timestampExpr})
    ORDER BY cost_usd DESC, date DESC
    LIMIT 1
  `).get(...filter.values) as { date: string; cost_usd: number } | undefined;

  const spanDays = inclusiveDateSpanDays(row.earliest, row.latest);
  const safeActiveDays = Math.max(row.active_days, 1);
  const safeSessions = Math.max(row.total_sessions, 1);

  return {
    total_cost_usd: row.total_cost_usd,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    total_cache_read_tokens: row.total_cache_read_tokens,
    total_cache_write_tokens: row.total_cache_write_tokens,
    total_usage_events: row.total_usage_events,
    total_sessions: row.total_sessions,
    active_days: row.total_usage_events > 0 ? row.active_days : 0,
    span_days: spanDays,
    average_cost_per_active_day: row.total_usage_events > 0 ? roundMetric(row.total_cost_usd / safeActiveDays) : 0,
    average_cost_per_session: row.total_sessions > 0 ? roundMetric(row.total_cost_usd / safeSessions) : 0,
    peak_day: peakDay ?? { date: null, cost_usd: 0 },
    coverage: getUsageCoverage(params),
  };
}

export function getUsageDaily(params: UsageParams = {}): UsageDailyPoint[] {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const usageWhere = [...filter.conditions, usageMetricsCondition('e')].join(' AND ');
  const timestampExpr = usageTimestampExpr('e');

  const rows = db.prepare(`
    SELECT
      date(${timestampExpr}) as date,
      ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
      COALESCE(SUM(e.tokens_in), 0) as input_tokens,
      COALESCE(SUM(e.tokens_out), 0) as output_tokens,
      COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
      COUNT(*) as usage_events,
      COUNT(DISTINCT e.session_id) as session_count
    FROM events e
    WHERE ${usageWhere}
    GROUP BY date(${timestampExpr})
    ORDER BY date ASC
  `).all(...filter.values) as UsageDailyPoint[];

  const bounds = resolveUsageDateBounds(
    params,
    rows[0]?.date ?? null,
    rows.length > 0 ? rows[rows.length - 1]?.date ?? null : null,
  );
  if (!bounds.from || !bounds.to) {
    return rows;
  }

  const byDate = new Map(rows.map(row => [row.date, row]));
  return enumerateDateRange(bounds.from, bounds.to).map(date => byDate.get(date) ?? {
    date,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usage_events: 0,
    session_count: 0,
  });
}

export function getUsageProjects(params: UsageParams = {}): UsageProjectBreakdown[] {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const where = [...filter.conditions, usageMetricsCondition('e')].join(' AND ');

  return db.prepare(`
    SELECT
      ${usageProjectExpr('e')} as project,
      ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
      COALESCE(SUM(e.tokens_in), 0) as input_tokens,
      COALESCE(SUM(e.tokens_out), 0) as output_tokens,
      COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
      COUNT(*) as usage_events,
      COUNT(DISTINCT e.session_id) as session_count
    FROM events e
    WHERE ${where}
    GROUP BY project
    ORDER BY cost_usd DESC, input_tokens DESC, project ASC
  `).all(...filter.values) as UsageProjectBreakdown[];
}

export function getUsageModels(params: UsageParams = {}): UsageModelBreakdown[] {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const where = [...filter.conditions, usageMetricsCondition('e')].join(' AND ');

  return db.prepare(`
    SELECT
      ${usageModelExpr('e')} as model,
      ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
      COALESCE(SUM(e.tokens_in), 0) as input_tokens,
      COALESCE(SUM(e.tokens_out), 0) as output_tokens,
      COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
      COUNT(*) as usage_events,
      COUNT(DISTINCT e.session_id) as session_count
    FROM events e
    WHERE ${where}
    GROUP BY model
    ORDER BY cost_usd DESC, input_tokens DESC, model ASC
  `).all(...filter.values) as UsageModelBreakdown[];
}

export function getUsageAgents(params: UsageParams = {}): UsageAgentBreakdown[] {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const where = [...filter.conditions, usageMetricsCondition('e')].join(' AND ');

  return db.prepare(`
    SELECT
      ${usageAgentExpr('e')} as agent,
      ROUND(COALESCE(SUM(e.cost_usd), 0), 6) as cost_usd,
      COALESCE(SUM(e.tokens_in), 0) as input_tokens,
      COALESCE(SUM(e.tokens_out), 0) as output_tokens,
      COALESCE(SUM(e.cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(e.cache_write_tokens), 0) as cache_write_tokens,
      COUNT(*) as usage_events,
      COUNT(DISTINCT e.session_id) as session_count
    FROM events e
    WHERE ${where}
    GROUP BY agent
    ORDER BY cost_usd DESC, input_tokens DESC, agent ASC
  `).all(...filter.values) as UsageAgentBreakdown[];
}

export function getUsageTopSessions(params: UsageParams = {}): UsageTopSessionRow[] {
  const db = getDb();
  const filter = buildUsageFilterState(params, 'e');
  const metricsCondition = usageMetricsCondition('e');
  const timestampExpr = usageTimestampExpr('e');
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);

  const rows = db.prepare(`
    SELECT
      e.session_id as id,
      COALESCE(MAX(NULLIF(e.project, '')), MAX(bs.project), MAX(s.project)) as project,
      COALESCE(MAX(e.agent_type), MAX(s.agent_type), MAX(bs.agent)) as agent,
      COALESCE(MAX(bs.started_at), MAX(s.started_at), MIN(${timestampExpr})) as started_at,
      COALESCE(MAX(bs.ended_at), MAX(s.ended_at), MAX(${timestampExpr})) as ended_at,
      MAX(${timestampExpr}) as last_activity_at,
      MAX(bs.message_count) as message_count,
      MAX(bs.user_message_count) as user_message_count,
      MAX(bs.fidelity) as fidelity,
      ROUND(COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.cost_usd ELSE 0 END), 0), 6) as cost_usd,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.tokens_in ELSE 0 END), 0) as input_tokens,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.tokens_out ELSE 0 END), 0) as output_tokens,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.cache_read_tokens ELSE 0 END), 0) as cache_read_tokens,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN e.cache_write_tokens ELSE 0 END), 0) as cache_write_tokens,
      COUNT(*) as event_count,
      COALESCE(SUM(CASE WHEN ${metricsCondition} THEN 1 ELSE 0 END), 0) as usage_events,
      CASE WHEN MAX(bs.id) IS NULL THEN 0 ELSE 1 END as browsing_session_available
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    LEFT JOIN browsing_sessions bs ON bs.id = e.session_id
    ${filter.where}
    GROUP BY e.session_id
    HAVING COALESCE(SUM(CASE WHEN ${metricsCondition} THEN 1 ELSE 0 END), 0) > 0
    ORDER BY cost_usd DESC, last_activity_at DESC, e.session_id DESC
    LIMIT ?
  `).all(...filter.values, limit) as Array<Omit<UsageTopSessionRow, 'browsing_session_available'> & { browsing_session_available: number }>;

  return rows.map(row => ({
    ...row,
    browsing_session_available: row.browsing_session_available === 1,
  }));
}

// --- Insights ---

function parseInsightRow(row: InsightDbRow): InsightRow {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    prompt: row.prompt,
    content: row.content,
    date_from: row.date_from,
    date_to: row.date_to,
    project: row.project,
    agent: row.agent,
    provider: row.provider,
    model: row.model,
    analytics_summary: JSON.parse(row.analytics_summary_json) as InsightRow['analytics_summary'],
    analytics_coverage: JSON.parse(row.analytics_coverage_json) as InsightRow['analytics_coverage'],
    usage_summary: JSON.parse(row.usage_summary_json) as InsightRow['usage_summary'],
    usage_coverage: JSON.parse(row.usage_coverage_json) as InsightRow['usage_coverage'],
    input_snapshot: JSON.parse(row.input_json) as InsightInputSnapshot,
    created_at: row.created_at,
  };
}

function buildInsightsFilterState(params: InsightsListParams = {}): {
  conditions: string[];
  values: unknown[];
  where: string;
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.kind) {
    conditions.push('kind = ?');
    values.push(params.kind);
  }
  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('date_to >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push('date_from <= ?');
    values.push(params.date_to);
  }

  return {
    conditions,
    values,
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
  };
}

export function listInsights(params: InsightsListParams = {}): InsightRow[] {
  const db = getDb();
  const filter = buildInsightsFilterState(params);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  return (db.prepare(`
    SELECT *
    FROM insights
    ${filter.where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...filter.values, limit) as InsightDbRow[]).map(parseInsightRow);
}

export function getInsight(id: number): InsightRow | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(id) as InsightDbRow | undefined;
  return row ? parseInsightRow(row) : undefined;
}

export function createInsight(input: {
  kind: GenerateInsightParams['kind'];
  title: string;
  prompt: string | null;
  content: string;
  date_from: string;
  date_to: string;
  project: string | null;
  agent: string | null;
  provider: string;
  model: string;
  analytics_summary: InsightRow['analytics_summary'];
  analytics_coverage: InsightRow['analytics_coverage'];
  usage_summary: InsightRow['usage_summary'];
  usage_coverage: InsightRow['usage_coverage'];
  input_snapshot: InsightInputSnapshot;
}): InsightRow {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO insights (
      kind,
      title,
      prompt,
      content,
      date_from,
      date_to,
      project,
      agent,
      provider,
      model,
      analytics_summary_json,
      analytics_coverage_json,
      usage_summary_json,
      usage_coverage_json,
      input_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.kind,
    input.title,
    input.prompt,
    input.content,
    input.date_from,
    input.date_to,
    input.project,
    input.agent,
    input.provider,
    input.model,
    JSON.stringify(input.analytics_summary),
    JSON.stringify(input.analytics_coverage),
    JSON.stringify(input.usage_summary),
    JSON.stringify(input.usage_coverage),
    JSON.stringify(input.input_snapshot),
  );

  const created = getInsight(Number(result.lastInsertRowid));
  if (!created) {
    throw new Error('Failed to load created insight');
  }
  return created;
}

export function deleteInsight(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM insights WHERE id = ?').run(id);
  return result.changes > 0;
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
