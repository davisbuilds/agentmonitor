<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  const maxMessages = $derived(Math.max(...analytics.activity.map((entry) => entry.messages), 1));
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Activity</h3>
      <p class="text-xs text-gray-500">Click a day to narrow the dashboard to that date.</p>
    </div>
    {#if analytics.coverage.activity}
      <span class="text-xs text-gray-500">{analytics.coverage.activity.included_sessions} sessions in range</span>
    {/if}
  </div>

  {#if analytics.loading.activity}
    <div class="py-12 text-center text-sm text-gray-500">Loading activity...</div>
  {:else if analytics.errors.activity}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.activity}</div>
  {:else if analytics.activity.length > 0}
    <div class="space-y-2">
      <div class="flex h-36 items-end gap-1">
        {#each analytics.activity as day}
          <button
            class="group flex-1 rounded-t bg-blue-500/60 transition-colors hover:bg-blue-400/80"
            style={`height:${Math.max((day.messages / maxMessages) * 100, 4)}%`}
            title={`${day.date}: ${day.messages} messages, ${day.sessions} sessions`}
            onclick={() => analytics.drillDownToDay(day.date)}
          >
            <span class="sr-only">{day.date}</span>
          </button>
        {/each}
      </div>
      <div class="flex justify-between text-[11px] text-gray-600">
        <span>{analytics.activity[0]?.date}</span>
        <span>{analytics.activity[analytics.activity.length - 1]?.date}</span>
      </div>
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No activity in the selected range.</div>
  {/if}
</section>
