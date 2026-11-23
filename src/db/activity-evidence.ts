// WHY: SQLite uses expression indexes only when the query expression matches the stored index
// expression.
export function observedInstant(column: string): string {
  return `CASE WHEN ${column} GLOB '*Z'
    OR (${column} GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND ${column} NOT GLOB '*-00:00')
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) END`;
}

export function activityEventInstant(alias = ''): string {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  return `CASE WHEN ${column('client_timestamp')} IS NULL AND ${column('source')} != 'import'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${column('created_at')})
    ELSE ${observedInstant(column('client_timestamp'))} END`;
}
