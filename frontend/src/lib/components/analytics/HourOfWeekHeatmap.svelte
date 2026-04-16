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
    if (messages <= 0) return 'rgba(59, 130, 246, 0.08)';
    const ratio = messages / maxMessages;
    return `rgba(59, 130, 246, ${0.2 + ratio * 0.75})`;
  }
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Hour Of Week</h3>
      <p class="text-xs text-gray-500">Message density by local weekday and hour.</p>
    </div>
    <span class="text-xs text-gray-500">24h local time</span>
  </div>

  {#if analytics.loading.hourOfWeek}
    <div class="py-12 text-center text-sm text-gray-500">Loading hour-of-week heatmap...</div>
  {:else if analytics.errors.hourOfWeek}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.hourOfWeek}</div>
  {:else}
    <div class="space-y-2">
      <div class="ml-12 grid grid-cols-24 gap-1 text-[10px] text-gray-600">
        {#each Array.from({ length: 24 }) as _, hour}
          <div class="text-center">{hour}</div>
        {/each}
      </div>
      {#each rows as row}
        <div class="grid grid-cols-[40px_1fr] items-center gap-2">
          <div class="text-xs text-gray-500">{row.label}</div>
          <div class="grid grid-cols-24 gap-1">
            {#each row.cells as cell}
              <div
                class="aspect-square rounded-sm border border-gray-900/40"
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
