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

// The operational-metric READ query lives in src/db/v2-queries.ts
// (getOperationalMetricSummary) — v2 SQL ownership stays centralized there.
// This module owns ingestion (insert) only.
