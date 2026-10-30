<script lang="ts">
  import { InfoTip } from '../ui';
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

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
      <div class="flex items-center gap-1.5">
        <h3 class="text-h3">Hour Of Week</h3>
        <InfoTip label="Hour Of Week"><p>Messages by the weekday and hour they were sent, in your local time. A session with no message times counts at its start.</p></InfoTip>
      </div>
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
      <!-- The scale: an empty hour, then four steps up to the busiest hour. -->
      <div class="ml-12 flex items-center justify-end gap-1.5 pt-1 text-meta tabular font-mono text-text-faint">
        <span>0</span>
        {#each [0, 0.25, 0.5, 0.75, 1] as step}
          <span class="h-3 w-3 rounded-sm" style={`background:${intensity(step * maxMessages)}`} aria-hidden="true"></span>
        {/each}
        <span>{formatNumber(maxMessages)} message{maxMessages === 1 ? '' : 's'}</span>
      </div>
    </div>
  {/if}
</section>
