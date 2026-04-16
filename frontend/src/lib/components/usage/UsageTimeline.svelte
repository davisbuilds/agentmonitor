<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';

  const maxCost = $derived.by(() => {
    let max = 0;
    for (const row of usage.daily) {
      if (row.cost_usd > max) max = row.cost_usd;
    }
    return max;
  });
</script>

<section class="rounded-xl border border-gray-800 bg-gray-950/60 p-4">
  <div class="flex items-center justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-white">Daily Usage</h2>
      <p class="mt-1 text-xs text-gray-500">Cost and token totals by event timestamp. Click a row to drill into one day.</p>
    </div>
  </div>

  {#if usage.loading.daily}
    <div class="mt-4 space-y-3">
      {#each Array.from({ length: 6 }) as _}
        <div class="space-y-2">
          <div class="h-3 w-20 animate-pulse rounded bg-gray-800"></div>
          <div class="h-2 animate-pulse rounded bg-gray-900"></div>
        </div>
      {/each}
    </div>
  {:else if usage.errors.daily}
    <div class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      {usage.errors.daily}
    </div>
  {:else if usage.daily.length === 0}
    <div class="mt-4 rounded-lg border border-dashed border-gray-800 px-4 py-10 text-center text-sm text-gray-500">
      No usage data for this range.
    </div>
  {:else}
    <div class="mt-4 space-y-3">
      {#each usage.daily as row}
        <button
          class="block w-full rounded-lg border border-transparent px-3 py-3 text-left transition hover:border-gray-700 hover:bg-gray-900/60"
          onclick={() => usage.setDateRange(row.date, row.date)}
        >
          <div class="flex items-center justify-between gap-3 text-sm">
            <span class="font-medium text-white">{row.date}</span>
            <span class="text-emerald-300">{formatCost(row.cost_usd)}</span>
          </div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-gray-900">
            <div
              class="h-full rounded-full bg-emerald-400 transition-all"
              style={`width: ${maxCost > 0 ? Math.max((row.cost_usd / maxCost) * 100, row.cost_usd > 0 ? 4 : 0) : 0}%`}
            ></div>
          </div>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
            <span>{formatNumber(row.input_tokens + row.output_tokens)} tokens</span>
            <span>{formatNumber(row.usage_events)} usage events</span>
            <span>{formatNumber(row.session_count)} session{row.session_count === 1 ? '' : 's'}</span>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</section>
