<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';
  import { Stat } from '../ui';

  interface Card {
    label: string;
    value: string;
    sub?: string;
    delta?: { value: string; tone?: 'ok' | 'danger' | 'muted' };
  }

  const summary = $derived(usage.summary);

  // Total Cost + Cache Hit Rate are promoted; the rest form a compact strip.
  const promoted = $derived.by((): Card[] => {
    if (!summary) return [];
    return [
      {
        label: 'Total Cost',
        value: formatCost(summary.total_cost_usd),
        delta: {
          value: `${summary.cost_delta_pct >= 0 ? '+' : ''}${summary.cost_delta_pct.toFixed(1)}%`,
          tone: summary.cost_delta_pct > 0 ? 'danger' : 'ok',
        },
        sub: `vs ${formatCost(summary.prior_total_cost_usd)} prior period`,
      },
      {
        label: 'Cache Hit Rate',
        value: `${(summary.cache_hit_rate * 100).toFixed(1)}%`,
        sub: `${formatCost(summary.estimated_cache_savings_usd)} estimated savings`,
      },
    ];
  });

  const rest = $derived.by((): Card[] => {
    if (!summary) return [];
    return [
      { label: 'Input Tokens', value: formatNumber(summary.total_input_tokens), sub: `${formatNumber(summary.total_cache_read_tokens)} cache reads` },
      { label: 'Output Tokens', value: formatNumber(summary.total_output_tokens), sub: `${formatNumber(summary.total_cache_write_tokens)} cache writes` },
      { label: 'Pricing Coverage', value: formatNumber(summary.pricing_known_events), sub: `${formatNumber(summary.pricing_unknown_events)} unknown events` },
      { label: 'Usage Events', value: formatNumber(summary.total_usage_events), sub: `${formatNumber(summary.total_sessions)} session${summary.total_sessions === 1 ? '' : 's'}` },
      { label: 'Active Days', value: formatNumber(summary.active_days), sub: `${formatNumber(summary.span_days)} day span` },
      { label: 'Peak Day', value: formatCost(summary.peak_day.cost_usd), sub: summary.peak_day.date ?? 'No data' },
    ];
  });
</script>

{#if usage.errors.summary}
  <div class="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-meta text-danger">
    {usage.errors.summary}
  </div>
{:else if usage.loading.summary && !summary}
  <div class="h-40 animate-pulse rounded-lg border border-line bg-surface"></div>
{:else if summary}
  <div class="overflow-hidden rounded-lg border border-line bg-line">
    <div class="grid grid-cols-1 gap-px sm:grid-cols-2">
      {#each promoted as card}
        <div class="bg-surface p-5">
          <Stat size="lg" label={card.label} value={card.value} sub={card.sub} delta={card.delta} />
        </div>
      {/each}
    </div>
    <div class="grid grid-cols-2 gap-px border-t border-line sm:grid-cols-3 lg:grid-cols-6">
      {#each rest as card}
        <div class="bg-surface p-4">
          <Stat label={card.label} value={card.value} sub={card.sub} />
        </div>
      {/each}
    </div>
  </div>
{/if}
