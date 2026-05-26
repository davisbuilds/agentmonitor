<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  const showingDate = $derived(analytics.from !== analytics.defaultFrom || analytics.to !== analytics.defaultTo);
  const dateLabel = $derived(showingDate ? `${analytics.from} to ${analytics.to}` : '');

  const chip = 'rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-meta text-text-muted transition-colors hover:border-line-strong hover:text-text';
</script>

{#if analytics.hasActiveFilters}
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-meta uppercase tracking-wide text-text-faint">Active filters</span>

    {#if showingDate}
      <button class={chip} onclick={() => analytics.clearDateRange()}>{dateLabel} ×</button>
    {/if}

    {#if analytics.project}
      <button class={chip} onclick={() => analytics.clearProject()}>Project: {analytics.project} ×</button>
    {/if}

    {#if analytics.agent}
      <button class={chip} onclick={() => analytics.clearAgent()}>Agent: {analytics.agent} ×</button>
    {/if}

    <button class="text-meta text-text-muted transition-colors hover:text-text" onclick={() => analytics.clearAllFilters()}>
      Clear all
    </button>
  </div>
{/if}
