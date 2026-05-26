<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { Stat } from '../ui';

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

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Velocity</h3>
      <p class="mt-0.5 text-meta text-text-muted">Pace metrics across active days and calendar span.</p>
    </div>
    {#if analytics.coverage.velocity}
      <span class="text-meta text-text-faint">{analytics.coverage.velocity.note}</span>
    {/if}
  </div>

  {#if analytics.loading.velocity}
    <div class="py-12 text-center text-meta text-text-muted">Loading velocity…</div>
  {:else if analytics.errors.velocity}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.velocity}</div>
  {:else if analytics.velocity}
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-3">
      {#each cards as card}
        <div class="bg-surface p-3">
          <Stat label={card.label} value={card.value} />
        </div>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No velocity data available.</div>
  {/if}
</section>
