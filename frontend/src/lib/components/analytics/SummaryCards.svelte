<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';
  import { Stat } from '../ui';

  const summary = $derived(analytics.summary);

  const cards = $derived.by(() => {
    if (!summary) return [];
    return [
      { label: 'Sessions', value: formatNumber(summary.total_sessions) },
      { label: 'Messages', value: formatNumber(summary.total_messages) },
      { label: 'User Messages', value: formatNumber(summary.total_user_messages) },
      { label: 'Sessions / Day', value: summary.daily_average_sessions.toFixed(1) },
      { label: 'Messages / Day', value: summary.daily_average_messages.toFixed(1) },
      { label: 'Coverage', value: `${summary.coverage.included_sessions}/${summary.coverage.matching_sessions}` },
    ];
  });
</script>

{#if analytics.errors.summary}
  <div class="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-meta text-danger">
    {analytics.errors.summary}
  </div>
{:else if analytics.loading.summary && !summary}
  <div class="h-24 animate-pulse rounded-lg border border-line bg-surface"></div>
{:else if summary}
  <div class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
    {#each cards as card}
      <div class="bg-surface p-4">
        <Stat label={card.label} value={card.value} />
      </div>
    {/each}
  </div>
{/if}
