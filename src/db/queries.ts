import { getDb } from './connection.js';
import { config } from '../config.js';

// --- Agents ---

export function upsertAgent(id: string, agentType: string, name?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (id, agent_type, name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')
  `).run(id, agentType, name || null);
}

// --- Sessions ---

export function upsertSession(
  id: string,
  agentId: string,
  agentType: string,
  project?: string,
  branch?: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_event_at = datetime('now'),
      status = CASE WHEN status = 'ended' THEN status ELSE 'active' END,
      project = COALESCE(excluded.project, sessions.project),
      branch = COALESCE(excluded.branch, sessions.branch)
  `).run(id, agentId, agentType, project || null, branch || null);
}

export interface SessionRow {
  id: string;
  agent_id: string;
  agent_type: string;
  project: string | null;
  branch: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  metadata: string;
  event_count: number;
  tokens_in: number;
  tokens_out: number;
}

export function getSessions(filters: {
  status?: string;
  agentType?: string;
  limit?: number;
}): SessionRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.agentType) {
    conditions.push('s.agent_type = ?');
    params.push(filters.agentType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;

  return db.prepare(`
    SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
      COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
      COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out
    FROM sessions s
    ${where}
    ORDER BY
      CASE s.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
      s.last_event_at DESC
    LIMIT ?
  `).all(...params, limit) as SessionRow[];
}

export function getSessionWithEvents(sessionId: string, eventLimit: number = 10): {
  session: SessionRow | undefined;
  events: EventRow[];
} {
  const db = getDb();
  const session = db.prepare(`
    SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
      COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
      COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out
    FROM sessions s WHERE s.id = ?
  `).get(sessionId) as SessionRow | undefined;

  const events = db.prepare(`
    SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, eventLimit) as EventRow[];

  return { session, events };
}

export function updateIdleSessions(timeoutMinutes: number): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE sessions SET status = 'idle'
    WHERE status = 'active'
    AND last_event_at < datetime('now', ? || ' minutes')
  `).run(`-${timeoutMinutes}`);
  return result.changes;
}

export function endSession(sessionId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET status = 'ended', ended_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);
}

// --- Events ---

export interface EventRow {
  id: number;
  event_id: string | null;
  schema_version: number;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  branch: string | null;
  project: string | null;
  duration_ms: number | null;
  created_at: string;
  metadata: string;
}

function truncateMetadata(metadata: unknown): string {
  const str = typeof metadata === 'string' ? metadata : JSON.stringify(metadata || {});
  const maxBytes = config.maxPayloadKB * 1024;
  if (str.length <= maxBytes) return str;
  return str.slice(0, maxBytes);
}

export function insertEvent(event: {
  event_id?: string;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name?: string;
  status?: string;
  tokens_in?: number;
  tokens_out?: number;
  branch?: string;
  project?: string;
  duration_ms?: number;
  metadata?: unknown;
}): EventRow | null {
  const db = getDb();

  const agentId = `${event.agent_type}-default`;
  upsertAgent(agentId, event.agent_type);
  upsertSession(event.session_id, agentId, event.agent_type, event.project, event.branch);

  // Handle session lifecycle events
  if (event.event_type === 'session_end') {
    endSession(event.session_id);
  }

  const metadataStr = truncateMetadata(event.metadata);

  try {
    const result = db.prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, tool_name, status,
        tokens_in, tokens_out, branch, project, duration_ms, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id || null,
      event.session_id,
      event.agent_type,
      event.event_type,
      event.tool_name || null,
      event.status || 'success',
      event.tokens_in || 0,
      event.tokens_out || 0,
      event.branch || null,
      event.project || null,
      event.duration_ms || null,
      metadataStr
    );

    if (result.changes === 0) return null; // duplicate event_id

    return db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid) as EventRow;
  } catch (err: unknown) {
    // UNIQUE constraint violation = duplicate event_id, silently skip
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: events.event_id')) {
      return null;
    }
    throw err;
  }
}

export function getEvents(filters: {
  limit?: number;
  offset?: number;
  agentType?: string;
  eventType?: string;
  toolName?: string;
  sessionId?: string;
  branch?: string;
  since?: string;
  until?: string;
}): { events: EventRow[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters.eventType) {
    conditions.push('event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.toolName) {
    conditions.push('tool_name = ?');
    params.push(filters.toolName);
  }
  if (filters.sessionId) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.branch) {
    conditions.push('branch = ?');
    params.push(filters.branch);
  }
  if (filters.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push('created_at <= ?');
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const total = (db.prepare(`SELECT COUNT(*) as count FROM events ${where}`).get(...params) as { count: number }).count;
  const events = db.prepare(`
    SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as EventRow[];

  return { events, total };
}

// --- Stats ---

export interface Stats {
  total_events: number;
  active_sessions: number;
  total_sessions: number;
  total_tokens_in: number;
  total_tokens_out: number;
  tool_breakdown: Record<string, number>;
  agent_breakdown: Record<string, number>;
  branches: string[];
}

export function getStats(filters?: { agentType?: string; since?: string }): Stats {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_events,
      COALESCE(SUM(tokens_in), 0) as total_tokens_in,
      COALESCE(SUM(tokens_out), 0) as total_tokens_out
    FROM events ${where}
  `).get(...params) as { total_events: number; total_tokens_in: number; total_tokens_out: number };

  const activeSessions = (db.prepare(
    `SELECT COUNT(*) as count FROM sessions WHERE status = 'active'`
  ).get() as { count: number }).count;

  const totalSessions = (db.prepare(
    `SELECT COUNT(*) as count FROM sessions`
  ).get() as { count: number }).count;

  const toolRows = db.prepare(`
    SELECT tool_name, COUNT(*) as count FROM events
    ${where.replace('WHERE', conditions.length ? 'WHERE' : '')}
    ${conditions.length > 0 ? 'AND' : 'WHERE'} tool_name IS NOT NULL
    GROUP BY tool_name ORDER BY count DESC
  `).all(...params) as { tool_name: string; count: number }[];

  const toolBreakdown: Record<string, number> = {};
  for (const row of toolRows) {
    toolBreakdown[row.tool_name] = row.count;
  }

  const agentRows = db.prepare(`
    SELECT agent_type, COUNT(*) as count FROM events ${where}
    GROUP BY agent_type ORDER BY count DESC
  `).all(...params) as { agent_type: string; count: number }[];

  const agentBreakdown: Record<string, number> = {};
  for (const row of agentRows) {
    agentBreakdown[row.agent_type] = row.count;
  }

  const branchRows = db.prepare(`
    SELECT DISTINCT branch FROM sessions WHERE branch IS NOT NULL ORDER BY last_event_at DESC
  `).all() as { branch: string }[];

  return {
    total_events: totals.total_events,
    active_sessions: activeSessions,
    total_sessions: totalSessions,
    total_tokens_in: totals.total_tokens_in,
    total_tokens_out: totals.total_tokens_out,
    tool_breakdown: toolBreakdown,
    agent_breakdown: agentBreakdown,
    branches: branchRows.map(r => r.branch),
  };
}
