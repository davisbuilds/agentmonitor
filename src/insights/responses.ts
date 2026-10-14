import { config } from '../config.js';
import { listInsights } from '../db/v2-queries.js';
import { isInsightProviderConfigured } from './service.js';
import type { InsightProvider, InsightRow, InsightsListParams } from '../api/v2/types.js';

export interface InsightGenerationStatus {
  default_provider: InsightProvider;
  providers: Record<InsightProvider, {
    configured: boolean;
    default_model: string;
  }>;
}

export interface InsightsListResponse {
  data: InsightRow[];
  generation: InsightGenerationStatus;
}

/** Canonical response shared by the HTTP and CLI read surfaces. */
export function getInsightsListResponse(params: InsightsListParams = {}): InsightsListResponse {
  return {
    data: listInsights(params),
    generation: {
      default_provider: config.insights.provider,
      providers: {
        openai: {
          configured: isInsightProviderConfigured('openai'),
          default_model: config.insights.providers.openai.model,
        },
        anthropic: {
          configured: isInsightProviderConfigured('anthropic'),
          default_model: config.insights.providers.anthropic.model,
        },
        gemini: {
          configured: isInsightProviderConfigured('gemini'),
          default_model: config.insights.providers.gemini.model,
        },
      },
    },
  };
}
