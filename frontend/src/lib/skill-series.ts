import type { SkillUsageDay } from './api/client';
import { OTHER_COLOR, OTHER_LABEL, SERIES_COLORS } from './components/usage/model-colors';

/** The skills the daily chart names; the rest fold into Other. */
export const SKILL_TOP_N = 10;

if (SKILL_TOP_N > SERIES_COLORS.length) {
  throw new Error(`The skills chart needs ${SKILL_TOP_N} series colors, got ${SERIES_COLORS.length}`);
}

export interface SkillSegment {
  name: string;
  count: number;
  color: string;
}

/**
 * The skills the daily chart names: the range's top SKILL_TOP_N by invocations, each
 * with its own color from the validated series palette. Every other skill folds
 * into Other, so no two named skills share a hue.
 */
export function skillSeries(days: readonly SkillUsageDay[]): { top: string[]; colors: Map<string, string> } {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const skill of day.skills) totals.set(skill.skill_name, (totals.get(skill.skill_name) ?? 0) + skill.count);
  }
  const top = [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SKILL_TOP_N)
    .map(([name]) => name);
  return { top, colors: new Map(top.map((name, index) => [name, SERIES_COLORS[index]])) };
}

/** A day's stack in the series order, so a skill keeps its slot from day to day. */
export function stackDay(day: SkillUsageDay, top: readonly string[], colors: ReadonlyMap<string, string>): SkillSegment[] {
  const counts = new Map(day.skills.map(skill => [skill.skill_name, skill.count]));
  const segments: SkillSegment[] = top
    .filter(name => (counts.get(name) ?? 0) > 0)
    .map(name => ({ name, count: counts.get(name)!, color: colors.get(name)! }));
  const other = day.skills.filter(skill => !top.includes(skill.skill_name)).reduce((sum, skill) => sum + skill.count, 0);
  if (other > 0) segments.push({ name: OTHER_LABEL, count: other, color: OTHER_COLOR });
  return segments;
}
