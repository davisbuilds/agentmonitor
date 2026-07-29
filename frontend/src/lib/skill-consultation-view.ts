import type {
  SkillConsultationAnalytics,
  SkillConsultationRow,
} from './api/client.js';
import type {
  AnalyticsSkillSignal,
  AnalyticsSkillSort,
} from './route-state.js';

export type SkillConsultationHarness = SkillConsultationAnalytics['byHarness'][number];
export type SkillConsultationSignal = AnalyticsSkillSignal;
export type SkillConsultationSort = AnalyticsSkillSort;

export interface SkillConsultationExplorerFilters {
  harness: string;
  query: string;
  signal: SkillConsultationSignal;
  sort: SkillConsultationSort;
}

export function countSkillRows(harnesses: SkillConsultationHarness[]): number {
  return harnesses.reduce((total, harness) => total + harness.skills.length, 0);
}

export function selectSkillConsultationPreview(
  harnesses: SkillConsultationHarness[],
  limit = 6,
): SkillConsultationHarness[] {
  if (limit <= 0) return [];

  const ranked = harnesses
    .map(harness => ({
      ...harness,
      skills: [...harness.skills].sort(compareVolume),
    }))
    .filter(harness => harness.skills.length > 0);
  const selected = new Map<string, SkillConsultationRow[]>(
    ranked.map(harness => [harness.harness, []]),
  );

  let selectedCount = 0;
  let rank = 0;
  while (selectedCount < limit) {
    let addedAtRank = false;
    for (const harness of ranked) {
      if (selectedCount >= limit) break;
      const row = harness.skills[rank];
      if (!row) continue;
      selected.get(harness.harness)?.push(row);
      selectedCount += 1;
      addedAtRank = true;
    }
    if (!addedAtRank) break;
    rank += 1;
  }

  return ranked
    .map(harness => ({
      ...harness,
      skills: selected.get(harness.harness) ?? [],
    }))
    .filter(harness => harness.skills.length > 0);
}

export function filterSkillConsultations(
  harnesses: SkillConsultationHarness[],
  filters: SkillConsultationExplorerFilters,
): SkillConsultationHarness[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const compare = comparatorFor(filters.sort);

  return harnesses
    .filter(harness => !filters.harness || harness.harness === filters.harness)
    .map(harness => ({
      ...harness,
      skills: harness.skills
        .filter(skill => !query || skill.name.toLocaleLowerCase().includes(query))
        .filter(skill => skillMatchesSignal(skill, filters.signal))
        .sort(compare),
    }))
    .filter(harness => harness.skills.length > 0);
}

export function skillMatchesSignal(
  skill: SkillConsultationRow,
  signal: SkillConsultationSignal,
): boolean {
  switch (signal) {
    case 'first_read':
      return skill.classes.first_read > 0;
    case 'rehydrated':
      return skill.classes.rehydration_after_compaction > 0;
    case 'presented_unread':
      return skill.exposure.presentedWithoutFirstRead > 0;
    case 'unclassified':
      return skill.classes.unclassifiable > 0;
    case 'all':
      return true;
  }
}

function compareVolume(a: SkillConsultationRow, b: SkillConsultationRow): number {
  return b.invocations - a.invocations || a.name.localeCompare(b.name);
}

function compareNullableRate(
  a: SkillConsultationRow,
  b: SkillConsultationRow,
): number {
  if (a.firstReadEngagementRate === null && b.firstReadEngagementRate === null) {
    return compareVolume(a, b);
  }
  if (a.firstReadEngagementRate === null) return 1;
  if (b.firstReadEngagementRate === null) return -1;
  return b.firstReadEngagementRate - a.firstReadEngagementRate || compareVolume(a, b);
}

function comparatorFor(
  sort: SkillConsultationSort,
): (a: SkillConsultationRow, b: SkillConsultationRow) => number {
  switch (sort) {
    case 'first_read_rate':
      return compareNullableRate;
    case 'rehydrations':
      return (a, b) => (
        b.classes.rehydration_after_compaction - a.classes.rehydration_after_compaction
        || compareVolume(a, b)
      );
    case 'name':
      return (a, b) => a.name.localeCompare(b.name);
    case 'volume':
      return compareVolume;
  }
}
