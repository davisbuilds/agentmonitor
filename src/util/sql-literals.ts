/** A list of SQL string literals, for an `IN (...)` built from a constant vocabulary. */
export function sqlStringList(values: readonly string[]): string {
  return values.map(value => `'${value.replaceAll("'", "''")}'`).join(', ');
}
