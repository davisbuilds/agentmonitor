export function usageMetricPresenceCondition(alias: string): string {
  return `(
    COALESCE(${alias}.cost_usd, 0) > 0
    OR COALESCE(${alias}.tokens_in, 0) > 0
    OR COALESCE(${alias}.tokens_out, 0) > 0
    OR COALESCE(${alias}.cache_read_tokens, 0) > 0
    OR COALESCE(${alias}.cache_write_tokens, 0) > 0
  )`;
}

function usageTimestampExpression(alias: string): string {
  return `datetime(COALESCE(${alias}.client_timestamp, ${alias}.created_at))`;
}

/**
 * An OTEL usage row the session's import already covers: the import holds
 * usage for the same session and agent at or after the row's time. Import is
 * authoritative for every source that has one (Claude transcripts, Codex
 * rollouts); OTEL fills the live tail the import has not reached yet. A Codex
 * OTEL row is dated at its request, and a metric row at the start of the
 * interval it covers, so a point exported after the last imported request is
 * still covered when its interval began before it.
 */
export function overlappingOtelUsageCondition(alias: string): string {
  return `(
    ${alias}.source = 'otel'
    AND ${usageMetricPresenceCondition(alias)}
    AND EXISTS (
      SELECT 1
      FROM events imported_usage
      WHERE imported_usage.session_id = ${alias}.session_id
        AND imported_usage.agent_type = ${alias}.agent_type
        AND imported_usage.source = 'import'
        AND ${usageMetricPresenceCondition('imported_usage')}
        AND ${usageTimestampExpression('imported_usage')} >= ${usageTimestampExpression(alias)}
    )
  )`;
}

export function excludeOverlappingOtelUsageCondition(alias: string): string {
  return `NOT ${overlappingOtelUsageCondition(alias)}`;
}

/**
 * Keep batch-imported benchmark rows (source='benchmark') out of an event-level
 * aggregate. A NULL source predates the column default and is never a benchmark
 * row, so it is retained. Used by the Monitor stats aggregates, which — unlike
 * the v2 usage layer's buildUsageFilterState — have no opt-in and always exclude
 * benchmark, because the Monitor is the live-activity view.
 */
export function excludeBenchmarkUsageCondition(alias: string): string {
  return `(${alias}.source IS NULL OR ${alias}.source != 'benchmark')`;
}
