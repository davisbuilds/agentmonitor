import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

interface PricingDataRates {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheReadCostPerMTok: number;
  /** Cache writes; Anthropic's 5-minute cache. */
  cacheWriteCostPerMTok: number;
  /** Anthropic's 1-hour cache writes, where the provider sells them. */
  cacheWrite1hCostPerMTok?: number;
}

interface PricingDataTier extends PricingDataRates {
  abovePromptTokens: number;
}

interface PricingDataSchedulePeriod extends PricingDataRates {
  from: string;
  tiers?: PricingDataTier[];
  /** Free-form provenance; ignored by the loader. */
  note?: string;
}

interface PricingDataModel extends PricingDataRates {
  aliases?: string[];
  deprecated: boolean;
  tiers?: PricingDataTier[];
  schedule?: PricingDataSchedulePeriod[];
}

interface PricingDataFile {
  provider: string;
  lastUpdated: string;
  models: Record<string, PricingDataModel>;
}

export interface PricingRates {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
  cacheWrite1hCostPerToken?: number;
}

export interface PricingTier extends PricingRates {
  abovePromptTokens: number;
}

/**
 * A dated rate period: from `from` (epoch ms; -Infinity for the base period)
 * onward, `rates` (tier-selected by `tiers` when present) are in force until a
 * later period supersedes them.
 */
export interface RatePeriod {
  from: number;
  rates: PricingRates;
  tiers?: PricingTier[];
}

export interface ModelPricing extends PricingRates {
  provider: string;
  deprecated: boolean;
  /** Higher prompt-size bands, ascending by threshold. Absent for flat models. */
  tiers?: PricingTier[];
  /**
   * Dated rate periods ascending by `from`; `periods[0]` is the base period
   * (from -Infinity) built from the inline rates. A model with no `schedule`
   * has exactly one period, so the date selection is a no-op for it.
   */
  periods: RatePeriod[];
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  /** All cache-write tokens, whichever cache they went to. */
  cacheWrite?: number;
  /** Of `cacheWrite`, the tokens written to Anthropic's 1-hour cache. */
  cacheWrite1h?: number;
}

export interface ResolvedModelPricing {
  canonicalModel: string;
  pricing: ModelPricing;
}

const M_TOK = 1_000_000;

function toPerToken(rates: PricingDataRates): PricingRates {
  const perToken: PricingRates = {
    inputCostPerToken: rates.inputCostPerMTok / M_TOK,
    outputCostPerToken: rates.outputCostPerMTok / M_TOK,
    cacheReadCostPerToken: rates.cacheReadCostPerMTok / M_TOK,
    cacheWriteCostPerToken: rates.cacheWriteCostPerMTok / M_TOK,
  };
  if (rates.cacheWrite1hCostPerMTok !== undefined) perToken.cacheWrite1hCostPerToken = rates.cacheWrite1hCostPerMTok / M_TOK;
  return perToken;
}

function buildTiers(tiers?: PricingDataTier[]): PricingTier[] | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  return tiers
    .map(tier => ({ ...toPerToken(tier), abovePromptTokens: tier.abovePromptTokens }))
    .sort((a, b) => a.abovePromptTokens - b.abovePromptTokens);
}

function buildPeriods(model: PricingDataModel, baseTiers?: PricingTier[]): RatePeriod[] {
  const base: RatePeriod = { from: -Infinity, rates: toPerToken(model), tiers: baseTiers };
  const scheduled: RatePeriod[] = (model.schedule ?? [])
    .map(period => ({ from: Date.parse(period.from), rates: toPerToken(period), tiers: buildTiers(period.tiers) }))
    .filter(period => Number.isFinite(period.from));
  return [base, ...scheduled].sort((a, b) => a.from - b.from);
}

/** A point in time to price at: a Date, epoch ms, or ISO string. */
export type PricingDate = Date | number | string;

// WHY: SQLite stores UTC without an offset; parsing as host-local time can select the wrong dated
// price.
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

export function normalizeSqliteTimestamp(value: string): string {
  const match = SQLITE_UTC.exec(value.trim());
  return match ? `${match[1]}T${match[2]}Z` : value;
}

function resolveAtMs(at?: PricingDate | null): number {
  if (at == null) return Date.now();
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  const ms = Date.parse(normalizeSqliteTimestamp(at));
  return Number.isFinite(ms) ? ms : Date.now();
}

function selectPeriod(pricing: ModelPricing, atMs: number): RatePeriod {
  let period = pricing.periods[0];
  for (const candidate of pricing.periods) {
    if (candidate.from <= atMs) period = candidate;
  }
  return period;
}

function selectRates(pricing: ModelPricing, tokens: TokenCounts, atMs: number): PricingRates {
  const period = selectPeriod(pricing, atMs);
  if (!period.tiers || period.tiers.length === 0) return period.rates;
  const promptTokens = tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  let rates: PricingRates = period.rates;
  for (const tier of period.tiers) {
    if (promptTokens > tier.abovePromptTokens) rates = tier;
  }
  return rates;
}

/**
 * Models that report usage but have no public rate to bill it at. They stay
 * unpriced (cost NULL) and are left out of the unpriced-model warning, which
 * would otherwise ask for a rate card that cannot exist.
 */
export const UNPRICEABLE_MODELS: ReadonlyMap<string, string> = new Map([
  // WHY: Codex auto-review is a routing alias without a billable model behind it.
  ['codex-auto-review', 'Codex routing alias with no public rate'],
]);

const BEDROCK_ANTHROPIC_ID = /^(?:(?:us|eu|apac|jp|au|ca|us-gov|global)\.)?anthropic\.(.+?)-v\d+(?::\d+)?$/;

/**
 * The rate-card spelling of a model ID: no `anthropic/`, `openai/` or `google/`
 * routing prefix, no Claude Code `[1m]` long-context suffix (Claude 4.6 and later
 * bill the full window at standard rates; Haiku 5.5's prompt-length tier lives
 * on its rate card, so dropping the suffix keeps it), and a Bedrock ID reduced to its
 * Anthropic model. Bedrock's regional-endpoint premium is not modeled.
 */
export function normalizeModelId(model: string): string {
  const id = model
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/^anthropic\//, '')
    .replace(/^openai\//, '')
    .replace(/^google\//, '');
  return BEDROCK_ANTHROPIC_ID.exec(id)?.[1] ?? id;
}

export class PricingRegistry {
  private models = new Map<string, ModelPricing>();
  private aliases = new Map<string, string>();

  constructor() {
    this.loadAll();
  }

  private loadAll(): void {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dataDir = path.join(__dirname, 'data');

    for (const file of ['claude.json', 'codex.json', 'gemini.json', 'openrouter.json']) {
      try {
        const raw = readFileSync(path.join(dataDir, file), 'utf-8');
        const data = JSON.parse(raw) as PricingDataFile;
        this.loadProvider(data);
      } catch {
        // WHY: A broken provider table must not prevent pricing from the other providers.
      }
    }
  }

  private loadProvider(data: PricingDataFile): void {
    for (const [canonicalName, model] of Object.entries(data.models)) {
      const baseTiers = buildTiers(model.tiers);
      const pricing: ModelPricing = {
        ...toPerToken(model),
        provider: data.provider,
        deprecated: model.deprecated,
        periods: buildPeriods(model, baseTiers),
      };

      if (baseTiers) pricing.tiers = baseTiers;

      this.models.set(canonicalName, pricing);

      if (model.aliases) {
        for (const alias of model.aliases) {
          this.aliases.set(alias, canonicalName);
        }
      }
    }
  }


  /**
   * Look up pricing for a model by canonical name or alias.
   */
  lookup(model: string): ModelPricing | null {
    return this.resolve(model)?.pricing ?? null;
  }

  /**
   * Resolve a model by canonical name or alias and return the canonical ID.
   */
  resolve(model: string): ResolvedModelPricing | null {
    const normalized = normalizeModelId(model);
    if (!normalized) return null;

    const direct = this.models.get(normalized);
    if (direct) {
      return { canonicalModel: normalized, pricing: direct };
    }

    const canonical = this.aliases.get(normalized);
    if (canonical) {
      const pricing = this.models.get(canonical);
      if (pricing) return { canonicalModel: canonical, pricing };
    }

    return null;
  }

  /**
   * Calculate cost in USD for a set of token counts, priced at the rates in
   * force at `at` (a Date, epoch ms, or ISO string). Pass the event's own
   * timestamp so a dated rate change is applied by when the event happened;
   * omit it to price at the current period. Returns null if the model is not found.
   */
  calculate(model: string, tokens: TokenCounts, at?: PricingDate | null): number | null {
    const pricing = this.lookup(model);
    if (!pricing) return null;

    const rates = selectRates(pricing, tokens, resolveAtMs(at));
    // WHY: The hour-long share is already counted in cache writes; it must not exceed that total.
    const cacheWrite = tokens.cacheWrite ?? 0;
    const cacheWrite1h = Math.min(Math.max(tokens.cacheWrite1h ?? 0, 0), cacheWrite);
    return (tokens.input * rates.inputCostPerToken)
      + (tokens.output * rates.outputCostPerToken)
      + ((tokens.cacheRead ?? 0) * rates.cacheReadCostPerToken)
      + ((cacheWrite - cacheWrite1h) * rates.cacheWriteCostPerToken)
      + (cacheWrite1h * (rates.cacheWrite1hCostPerToken ?? rates.cacheWriteCostPerToken));
  }

  /**
   * Resolve the effective per-token rates for a request, selected by date (`at`)
   * then tier-selected by prompt size (uncached `input` + `cacheRead` +
   * `cacheWrite`). Flat models return their base rates. Returns null when the
   * model is unknown. Use this anywhere a cost/savings figure must agree with
   * `calculate()` on long-context tiered or dated pricing.
   */
  effectiveRates(model: string, tokens: TokenCounts, at?: PricingDate | null): PricingRates | null {
    const pricing = this.lookup(model);
    if (!pricing) return null;
    return selectRates(pricing, tokens, resolveAtMs(at));
  }

  /**
   * Check if a model is known to the registry.
   */
  has(model: string): boolean {
    return this.lookup(model) !== null;
  }

  /**
   * Get all known canonical model names.
   */
  get knownModels(): string[] {
    return [...this.models.keys()];
  }
}

export const pricingRegistry = new PricingRegistry();
