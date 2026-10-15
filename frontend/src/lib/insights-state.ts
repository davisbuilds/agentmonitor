import type { Insight, InsightKind } from './api/client';

export interface InsightListFilters {
  from: string;
  to: string;
  project: string;
  agent: string;
  kind: InsightKind;
}

function normalizeNullable(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function sameInsightListFilters(a: InsightListFilters, b: InsightListFilters): boolean {
  return a.from === b.from
    && a.to === b.to
    && a.project === b.project
    && a.agent === b.agent
    && a.kind === b.kind;
}

export function insightMatchesListFilters(insight: Insight, filters: InsightListFilters): boolean {
  if (insight.kind !== filters.kind) return false;
  if (filters.project && normalizeNullable(insight.project) !== filters.project) return false;
  if (filters.agent && normalizeNullable(insight.agent) !== filters.agent) return false;
  return insight.date_to >= filters.from && insight.date_from <= filters.to;
}
