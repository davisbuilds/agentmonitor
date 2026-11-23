import { getDb } from './connection.js';

// WHY: Operational counters carry no usage and would inflate event aggregates if stored alongside
// normal events.

export type MetricTemporality = 'delta' | 'cumulative' | 'gauge';

export interface OperationalMetricRecord {
  /**
   * Retry identity of the OTLP data point (see parser "Retry identity"). A point
   * whose key is already stored is an exporter resend and is not inserted again;
   * a point without one (no producer time) is always inserted.
   */
  point_id?: string;
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

/**
 * Insert a batch of operational metrics in one transaction. Returns the count
 * inserted, which excludes resent points whose `point_id` is already stored.
 */
export function insertOperationalMetrics(records: OperationalMetricRecord[]): number {
  if (records.length === 0) return 0;
  const db = getDb();
  // WHY: Target only the retry key so an unrelated constraint violation still surfaces.
  const stmt = db.prepare(`
    INSERT INTO otel_metrics (point_id, session_id, agent_type, metric_name, attrs, value, temporality, client_timestamp)
    VALUES (@point_id, @session_id, @agent_type, @metric_name, @attrs, @value, @temporality, @client_timestamp)
    ON CONFLICT(point_id) DO NOTHING
  `);
  const insertAll = db.transaction((rows: OperationalMetricRecord[]) => {
    let inserted = 0;
    for (const row of rows) {
      inserted += stmt.run({
        point_id: row.point_id ?? null,
        session_id: row.session_id,
        agent_type: row.agent_type,
        metric_name: row.metric_name,
        attrs: row.attrs ? JSON.stringify(row.attrs) : null,
        value: row.value,
        temporality: row.temporality,
        client_timestamp: row.client_timestamp ?? null,
      }).changes;
    }
    return inserted;
  });
  return insertAll(records);
}
