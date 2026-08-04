export interface ModelUsageLike {
  model: string;
  pricing_status: 'known' | 'deprecated' | 'unknown';
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
}

export interface UnpricedUsageSummary {
  model_count: number;
  usage_events: number;
  observed_tokens: number;
  models: string[];
}

export function observedTokens(model: Pick<ModelUsageLike, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): number {
  return model.input_tokens + model.output_tokens + model.cache_read_tokens + model.cache_write_tokens;
}

export function summarizeUnpricedUsage(models: readonly ModelUsageLike[]): UnpricedUsageSummary | null {
  const unknownModels = models
    .filter(model => model.pricing_status === 'unknown')
    .sort((left, right) => observedTokens(right) - observedTokens(left) || left.model.localeCompare(right.model));

  if (unknownModels.length === 0) return null;

  return {
    model_count: unknownModels.length,
    usage_events: unknownModels.reduce((total, model) => total + model.usage_events, 0),
    observed_tokens: unknownModels.reduce((total, model) => total + observedTokens(model), 0),
    models: unknownModels.map(model => model.model),
  };
}
