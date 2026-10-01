/**
 * Hints read from an EXPLAIN QUERY PLAN, for ranking statements worth a look.
 * They are not verdicts: a scan of a ten-row table is fine. The one that
 * matters most here is an aggregate that looks up rows: an index finds the
 * matches but does not hold every column the statement filters or sums, so each
 * match costs a table lookup (a Monitor count once spent 3 s that way while its
 * page took 3 ms).
 */
export type PlanFlag = 'temp_btree' | 'full_scan' | 'row_lookups' | 'aggregate_row_lookups';

export function planFlags(sql: string, plan: string[]): PlanFlag[] {
  const flags = new Set<PlanFlag>();
  for (const step of plan) {
    if (/\bUSE TEMP B-TREE\b/.test(step)) flags.add('temp_btree');
    if (/^SCAN \w+$/.test(step)) flags.add('full_scan');
    if (/^(SEARCH|SCAN) \w+ USING INDEX\b/.test(step)) flags.add('row_lookups');
  }
  if (flags.has('row_lookups') && /\b(COUNT|SUM|TOTAL|AVG|MIN|MAX)\s*\(/i.test(sql)) flags.add('aggregate_row_lookups');
  return [...flags];
}
