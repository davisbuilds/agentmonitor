<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  const showingDate = $derived(analytics.from !== analytics.defaultFrom || analytics.to !== analytics.defaultTo);
  const dateLabel = $derived(showingDate ? `${analytics.from} to ${analytics.to}` : '');
</script>

{#if analytics.hasActiveFilters}
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-xs uppercase tracking-wide text-gray-600">Active Filters</span>

    {#if showingDate}
      <button class="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-200 hover:border-sky-400/50" onclick={() => analytics.clearDateRange()}>
        {dateLabel} ×
      </button>
    {/if}

    {#if analytics.project}
      <button class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200 hover:border-emerald-400/50" onclick={() => analytics.clearProject()}>
        Project: {analytics.project} ×
      </button>
    {/if}

    {#if analytics.agent}
      <button class="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-200 hover:border-amber-400/50" onclick={() => analytics.clearAgent()}>
        Agent: {analytics.agent} ×
      </button>
    {/if}

    <button class="text-xs text-gray-400 hover:text-white" onclick={() => analytics.clearAllFilters()}>
      Clear all
    </button>
  </div>
{/if}
