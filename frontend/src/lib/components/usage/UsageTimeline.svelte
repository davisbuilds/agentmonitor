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

<section class="flex h-full flex-col rounded-lg border border-line bg-surface p-4 xl:max-h-[34rem]">
  <div>
    <h3 class="text-h3">Daily Usage</h3>
    <p class="mt-0.5 text-meta text-text-muted">Cost and token totals by event timestamp. Click a row to drill into one day.</p>
  </div>

  {#if usage.loading.daily}
    <div class="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
      {#each Array.from({ length: 6 }) as _}
        <div class="space-y-2">
          <div class="h-3 w-20 animate-pulse rounded-sm bg-surface-2"></div>
          <div class="h-2 animate-pulse rounded-sm bg-surface-2"></div>
        </div>
      {/each}
    </div>
  {:else if usage.errors.daily}
    <div class="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">
      {usage.errors.daily}
    </div>
  {:else if usage.daily.length === 0}
    <div class="mt-4 flex flex-1 items-center justify-center rounded-sm border border-dashed border-line px-4 py-10 text-center text-meta text-text-faint">
      No usage data for this range.
    </div>
  {:else}
    <div class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
      <div class="space-y-1">
      {#each usage.daily as row}
        <button
          class="block w-full rounded-sm border border-transparent px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-surface-2"
          onclick={() => usage.setDateRange(row.date, row.date)}
        >
          <div class="flex items-center justify-between gap-3 text-body">
            <span class="tabular font-mono text-text">{row.date}</span>
            <span class="tabular font-mono text-ok">{formatCost(row.cost_usd)}</span>
          </div>
          <div class="mt-2 h-1.5 overflow-hidden rounded-sm bg-surface-2">
            <div
              class="h-full rounded-sm bg-accent transition-all"
              style={`width: ${maxCost > 0 ? Math.max((row.cost_usd / maxCost) * 100, row.cost_usd > 0 ? 4 : 0) : 0}%`}
            ></div>
          </div>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-meta tabular font-mono text-text-faint">
            <span>{formatNumber(row.input_tokens + row.output_tokens)} tokens</span>
            <span>{formatNumber(row.usage_events)} usage events</span>
            <span>{formatNumber(row.session_count)} session{row.session_count === 1 ? '' : 's'}</span>
          </div>
        </button>
      {/each}
      </div>
    </div>
  {/if}
</section>
