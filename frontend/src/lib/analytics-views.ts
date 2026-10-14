import type { InsightGenerationStatus } from './api/client';
import type { AnalyticsView } from './route-state';

/**
 * Whether Insights can do anything: true once any provider has an API key,
 * false when none does, null while the status has not loaded yet.
 */
export type InsightsAvailability = boolean | null;

export function anyInsightProviderConfigured(generation: InsightGenerationStatus): boolean {
  return Object.values(generation.providers).some(provider => provider.configured);
}

/** The Analytics sub-views to offer. Insights is hidden until a key is known to exist. */
export function visibleAnalyticsViews(insights: InsightsAvailability): AnalyticsView[] {
  const views: AnalyticsView[] = ['overview', 'usage', 'skills', 'insights', 'quality'];
  return insights === true ? views : views.filter(view => view !== 'insights');
}

/**
 * The sub-view to render for a requested one. A deep link to Insights falls back
 * to Overview when no key is configured, and waits (null) while that is unknown
 * so the page neither flashes Insights nor jumps away from it.
 */
export function resolveAnalyticsView(
  requested: AnalyticsView,
  insights: InsightsAvailability,
): AnalyticsView | null {
  if (requested !== 'insights') return requested;
  if (insights === null) return null;
  return insights ? 'insights' : 'overview';
}
