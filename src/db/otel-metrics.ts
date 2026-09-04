import { getDb } from './connection.js';

// Storage + read layer for operational OTEL metrics (Bucket A). Kept out of the
// `events` table on purpose: these rows carry no tokens/cost and must never be
// visible to usage/cost or the COUNT(*)/event_type aggregates over `events`.

export type MetricTemporality = 'delta' | 'cumulative' | 'gauge';

export interface OperationalMetricRecord {
  session_id: string;
  agent_type: string;
  metric_name: string;
  /** Outcome/state attributes (the low-cardinality labels that give the metric meaning). */
  attrs?: Record<string, string | number | boolean>;
  value: number;
  temporality: MetricTemporality;
  client_timestamp?: string;
}

export interface OperationalMetricRow extends OperationalMetricRecord {
  id: number;
  created_at: string;
}

/** Insert a batch of operational metrics in one transaction. Returns the count inserted. */
export function insertOperationalMetrics(records: OperationalMetricRecord[]): number {
  if (records.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO otel_metrics (session_id, agent_type, metric_name, attrs, value, temporality, client_timestamp)
    VALUES (@session_id, @agent_type, @metric_name, @attrs, @value, @temporality, @client_timestamp)
  `);
  const insertAll = db.transaction((rows: OperationalMetricRecord[]) => {
    for (const row of rows) {
      stmt.run({
        session_id: row.session_id,
        agent_type: row.agent_type,
        metric_name: row.metric_name,
        attrs: row.attrs ? JSON.stringify(row.attrs) : null,
        value: row.value,
        temporality: row.temporality,
        client_timestamp: row.client_timestamp ?? null,
      });
    }
  });
  insertAll(records);
  return records.length;
}

export interface OperationalMetricQuery {
  /** Prefix match on metric_name, e.g. "codex.memory." */
  namePrefix?: string;
  agentType?: string;
  sessionId?: string;
  /** ISO lower bound on COALESCE(client_timestamp, created_at). */
  since?: string;
  limit?: number;
}

/**
 * Aggregated operational-metric view: one row per (metric_name, attrs), with the
 * occurrence count, summed value, and last-seen time. This is the shape that
 * answers "is codex.memory consolidation running, and what states is it hitting?"
 * — attrs is grouped verbatim so `state=skipped_rate_limit` vs `succeeded` split.
 */
export interface OperationalMetricSummaryRow {
  metric_name: string;
  attrs: Record<string, unknown> | null;
  occurrences: number;
  total_value: number;
  last_seen: string;
}

export function getOperationalMetricSummary(query: OperationalMetricQuery = {}): OperationalMetricSummaryRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (query.namePrefix) {
    conditions.push('metric_name LIKE ?');
    values.push(`${query.namePrefix}%`);
  }
  if (query.agentType) {
    conditions.push('agent_type = ?');
    values.push(query.agentType);
  }
  if (query.sessionId) {
    conditions.push('session_id = ?');
    values.push(query.sessionId);
  }
  if (query.since) {
    conditions.push("COALESCE(client_timestamp, created_at) >= datetime(?)");
    values.push(query.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Number.isFinite(query.limit) && (query.limit as number) > 0 ? Math.trunc(query.limit as number) : 200;

  const rows = db.prepare(`
    SELECT metric_name,
           attrs,
           COUNT(*) AS occurrences,
           SUM(value) AS total_value,
           MAX(COALESCE(client_timestamp, created_at)) AS last_seen
    FROM otel_metrics
    ${where}
    GROUP BY metric_name, attrs
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(...values, limit) as Array<{
    metric_name: string;
    attrs: string | null;
    occurrences: number;
    total_value: number;
    last_seen: string;
  }>;

  return rows.map(row => ({
    metric_name: row.metric_name,
    attrs: row.attrs ? (JSON.parse(row.attrs) as Record<string, unknown>) : null,
    occurrences: row.occurrences,
    total_value: row.total_value,
    last_seen: row.last_seen,
  }));
}
