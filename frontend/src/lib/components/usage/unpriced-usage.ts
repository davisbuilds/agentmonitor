export interface ModelUsageLike {
  model: string;
  pricing_status: 'known' | 'deprecated' | 'unknown';
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_events: number;
}

export interface IncompleteCostUsageSummary {
  model_count: number;
  unknown_pricing_model_count: number;
  unrecalculated_model_count: number;
  usage_events: number;
  observed_tokens: number;
  models: string[];
}

export function observedTokens(model: Pick<ModelUsageLike, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): number {
  return model.input_tokens + model.output_tokens + model.cache_read_tokens + model.cache_write_tokens;
}

export function summarizeIncompleteCostUsage(models: readonly ModelUsageLike[]): IncompleteCostUsageSummary | null {
  const affectedModels = models
    .filter(model => (
      model.pricing_status === 'unknown'
      || (model.cost_usd === 0 && observedTokens(model) > 0)
    ))
    .sort((left, right) => observedTokens(right) - observedTokens(left) || left.model.localeCompare(right.model));

  if (affectedModels.length === 0) return null;

  return {
    model_count: affectedModels.length,
    unknown_pricing_model_count: affectedModels.filter(model => model.pricing_status === 'unknown').length,
    unrecalculated_model_count: affectedModels.filter(model => model.pricing_status !== 'unknown').length,
    usage_events: affectedModels.reduce((total, model) => total + model.usage_events, 0),
    observed_tokens: affectedModels.reduce((total, model) => total + observedTokens(model), 0),
    models: affectedModels.map(model => model.model),
  };
}
