<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  const cards = $derived.by(() => {
    const velocity = analytics.velocity;
    if (!velocity) return [];
    return [
      { label: 'Active Days', value: String(velocity.active_days) },
      { label: 'Span Days', value: String(velocity.span_days) },
      { label: 'Sessions / Active Day', value: velocity.sessions_per_active_day.toFixed(1) },
      { label: 'Messages / Active Day', value: velocity.messages_per_active_day.toFixed(1) },
      { label: 'Sessions / Calendar Day', value: velocity.sessions_per_calendar_day.toFixed(1) },
      { label: 'Avg Messages / Session', value: velocity.average_messages_per_session.toFixed(1) },
    ];
  });
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Velocity</h3>
      <p class="text-xs text-gray-500">Pace metrics across active days and calendar span.</p>
    </div>
    {#if analytics.coverage.velocity}
      <span class="text-xs text-gray-500">{analytics.coverage.velocity.note}</span>
    {/if}
  </div>

  {#if analytics.loading.velocity}
    <div class="py-12 text-center text-sm text-gray-500">Loading velocity...</div>
  {:else if analytics.errors.velocity}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.velocity}</div>
  {:else if analytics.velocity}
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-3">
      {#each cards as card}
        <div class="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
          <div class="text-lg font-semibold text-gray-100">{card.value}</div>
          <div class="mt-1 text-xs text-gray-500">{card.label}</div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No velocity data available.</div>
  {/if}
</section>
