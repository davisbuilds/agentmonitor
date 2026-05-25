<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';

  interface Card {
    label: string;
    value: string;
    sub?: string;
  }

  const cards = $derived.by((): Card[] => {
    const summary = usage.summary;
    if (!summary) {
      return [];
    }

    return [
      {
        label: 'Total Cost',
        value: formatCost(summary.total_cost_usd),
        sub: `${summary.cost_delta_pct >= 0 ? '+' : ''}${summary.cost_delta_pct.toFixed(1)}% vs ${formatCost(summary.prior_total_cost_usd)} prior`,
      },
      {
        label: 'Input Tokens',
        value: formatNumber(summary.total_input_tokens),
        sub: `${formatNumber(summary.total_cache_read_tokens)} cache reads`,
      },
      {
        label: 'Cache Hit Rate',
        value: `${(summary.cache_hit_rate * 100).toFixed(1)}%`,
        sub: `${formatCost(summary.estimated_cache_savings_usd)} estimated savings`,
      },
      {
        label: 'Output Tokens',
        value: formatNumber(summary.total_output_tokens),
        sub: `${formatNumber(summary.total_cache_write_tokens)} cache writes`,
      },
      {
        label: 'Pricing Coverage',
        value: formatNumber(summary.pricing_known_events),
        sub: `${formatNumber(summary.pricing_unknown_events)} unknown events`,
      },
      {
        label: 'Usage Events',
        value: formatNumber(summary.total_usage_events),
        sub: `${formatNumber(summary.total_sessions)} session${summary.total_sessions === 1 ? '' : 's'}`,
      },
      {
        label: 'Active Days',
        value: formatNumber(summary.active_days),
        sub: `${formatNumber(summary.span_days)} day span`,
      },
      {
        label: 'Peak Day',
        value: formatCost(summary.peak_day.cost_usd),
        sub: summary.peak_day.date ?? 'No data',
      },
    ];
  });
</script>

<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
  {#each cards as card}
    <div class="rounded-xl border border-gray-800 bg-gray-950/60 p-4">
      {#if usage.loading.summary}
        <div class="h-7 w-20 animate-pulse rounded bg-gray-800"></div>
        <div class="mt-3 h-3 w-28 animate-pulse rounded bg-gray-900"></div>
      {:else if usage.errors.summary}
        <div class="text-lg font-semibold text-gray-300">--</div>
        <div class="mt-1 text-sm text-gray-500">{card.label}</div>
      {:else}
        <div class="text-2xl font-semibold text-white">{card.value}</div>
        <div class="mt-1 text-sm text-gray-400">{card.label}</div>
        {#if card.sub}
          <div class="mt-2 text-xs text-gray-500">{card.sub}</div>
        {/if}
      {/if}
    </div>
  {/each}
</div>

{#if usage.errors.summary}
  <div class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
    {usage.errors.summary}
  </div>
{/if}
