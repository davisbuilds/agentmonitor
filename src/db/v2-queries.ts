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
  AnalyticsCoverage,
  HourOfWeekDataPoint,
  TopSessionStat,
  VelocityMetrics,
  AgentComparisonRow,
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
