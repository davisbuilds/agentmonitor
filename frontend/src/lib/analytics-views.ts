import type { InsightGenerationStatus } from './api/client';
import type { AnalyticsView } from './route-state';

/**
 * Whether Insights has anything to offer: true once any provider has an API key
 * or any insight is saved, false when neither, null while that is unknown.
 */
export type InsightsAvailability = boolean | null;

export function anyInsightProviderConfigured(generation: InsightGenerationStatus): boolean {
  return Object.values(generation.providers).some(provider => provider.configured);
}

/** Saved insights stay readable after every key is removed; only generating needs one. */
export function insightsViewAvailable(generation: InsightGenerationStatus, hasSavedInsights: boolean): boolean {
  return hasSavedInsights || anyInsightProviderConfigured(generation);
}

/** The Analytics sub-views to offer. Insights is hidden until a key or a saved insight is known to exist. */
export function visibleAnalyticsViews(insights: InsightsAvailability): AnalyticsView[] {
  const views: AnalyticsView[] = ['overview', 'usage', 'skills', 'insights', 'quality'];
  return insights === true ? views : views.filter(view => view !== 'insights');
}

/**
 * The sub-view to render for a requested one. A deep link to Insights falls back
 * to Overview with neither a key nor a saved insight, and waits (null) while that
 * is unknown so the page neither flashes Insights nor jumps away from it.
 */
export function resolveAnalyticsView(
  requested: AnalyticsView,
  insights: InsightsAvailability,
): AnalyticsView | null {
  if (requested !== 'insights') return requested;
  if (insights === null) return null;
  return insights ? 'insights' : 'overview';
}
