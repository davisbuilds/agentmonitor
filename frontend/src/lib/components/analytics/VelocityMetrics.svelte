<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { InfoTip, Stat } from '../ui';

  const cards = $derived.by(() => {
    const velocity = analytics.velocity;
    if (!velocity) return [];
    return [
      { label: 'Active Days', value: `${velocity.active_days} of ${velocity.span_days}` },
      { label: 'Sessions / Active Day', value: velocity.sessions_per_active_day.toFixed(1) },
      { label: 'Messages / Active Day', value: velocity.messages_per_active_day.toFixed(1) },
      { label: 'Avg Messages / Session', value: velocity.average_messages_per_session.toFixed(1) },
    ];
  });
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <div class="flex items-center gap-1.5">
        <h3 class="text-h3">Velocity</h3>
        <InfoTip label="Velocity"><p>Pace on the days you were active. Per-day figures across the whole range are in the summary above.</p></InfoTip>
      </div>
    </div>
  </div>

  {#if analytics.loading.velocity}
    <div class="py-12 text-center text-meta text-text-muted">Loading velocity…</div>
  {:else if analytics.errors.velocity}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.velocity}</div>
  {:else if analytics.velocity}
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line">
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
