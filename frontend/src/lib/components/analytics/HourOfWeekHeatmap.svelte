<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const maxMessages = $derived(Math.max(...analytics.hourOfWeek.map((entry) => entry.message_count), 1));
  const rows = $derived(
    dayLabels.map((label, dayIndex) => ({
      label,
      cells: analytics.hourOfWeek.filter((entry) => entry.day_of_week === dayIndex),
    })),
  );

  function intensity(messages: number): string {
    const ratio = messages <= 0 ? 0 : 0.18 + (messages / maxMessages) * 0.72;
    const pct = messages <= 0 ? 6 : Math.round(ratio * 100);
    return `color-mix(in oklch, var(--color-accent) ${pct}%, transparent)`;
  }
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Hour Of Week</h3>
      <p class="mt-0.5 text-meta text-text-muted">Message density by local weekday and hour.</p>
    </div>
    <span class="text-meta text-text-faint">24h local time</span>
  </div>

  {#if analytics.loading.hourOfWeek}
    <div class="py-12 text-center text-meta text-text-muted">Loading hour-of-week heatmap…</div>
  {:else if analytics.errors.hourOfWeek}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.hourOfWeek}</div>
  {:else}
    <div class="space-y-2">
      <div class="ml-12 grid grid-cols-24 gap-1 text-meta tabular font-mono text-text-faint">
        {#each Array.from({ length: 24 }) as _, hour}
          <div class="text-center">{hour}</div>
        {/each}
      </div>
      {#each rows as row}
        <div class="grid grid-cols-[40px_1fr] items-center gap-2">
          <div class="text-meta text-text-faint">{row.label}</div>
          <div class="grid grid-cols-24 gap-1">
            {#each row.cells as cell}
              <div
                class="aspect-square rounded-sm"
                style={`background:${intensity(cell.message_count)}`}
                title={`${row.label} ${String(cell.hour_of_day).padStart(2, '0')}:00 · ${cell.message_count} messages · ${cell.session_count} sessions`}
              ></div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
