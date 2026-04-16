<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

  const cards = $derived.by(() => {
    const summary = analytics.summary;
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

<section class="space-y-3">
  <div class="flex items-center justify-between gap-3">
    <div>
      <h2 class="text-lg font-semibold text-gray-100">Analytics</h2>
      <p class="text-sm text-gray-500">History-backed session analytics with explicit capability coverage.</p>
    </div>
    {#if analytics.coverage.summary}
      <div class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
        {analytics.coverage.summary.note}
      </div>
    {/if}
  </div>

  {#if analytics.loading.summary}
    <div class="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
      {#each Array.from({ length: 6 }) as _}
        <div class="rounded-xl border border-gray-800 bg-gray-900/50 p-3">
          <div class="h-5 w-16 animate-pulse rounded bg-gray-800"></div>
          <div class="mt-2 h-3 w-24 animate-pulse rounded bg-gray-800"></div>
        </div>
      {/each}
    </div>
  {:else if analytics.summary}
    <div class="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
      {#each cards as card}
        <div class="h-full rounded-xl border border-gray-800 bg-gray-900/50 p-3">
          <div class="text-lg font-bold text-gray-100">{card.value}</div>
          <div class="mt-1 text-xs text-gray-500">{card.label}</div>
        </div>
      {/each}
    </div>
  {:else if analytics.errors.summary}
    <div class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {analytics.errors.summary}
    </div>
  {/if}
</section>
