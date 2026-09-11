import type { OperationalMetricSummaryRow } from '../../db/v2-queries.js';
import { formatRows } from './reporting.js';

/**
 * Flatten a metric's attribute bag into a stable, human-readable `k=v` string,
 * sorted by key so the same attrs always render identically. Returns '-' for
 * no attributes so the table cell is never blank.
 */
export function formatAttrs(attrs: Record<string, unknown> | null): string {
  if (!attrs) return '-';
  const keys = Object.keys(attrs).sort();
  if (keys.length === 0) return '-';
  return keys.map(key => `${key}=${attrs[key]}`).join(' ');
}

/**
 * Render the operational-metric summary as a table: one row per
 * (metric_name, attrs), with occurrences, summed value, and last-seen time.
 */
export function formatOpsMetrics(rows: OperationalMetricSummaryRow[]): string {
  const flattened = rows.map(row => ({
    metric_name: row.metric_name,
    attrs: formatAttrs(row.attrs),
    occurrences: row.occurrences,
    total_value: row.total_value,
    last_seen: row.last_seen,
  }));
  return formatRows(flattened, ['metric_name', 'attrs', 'occurrences', 'total_value', 'last_seen']);
}
