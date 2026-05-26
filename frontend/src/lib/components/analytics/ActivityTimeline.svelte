<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  const maxMessages = $derived(Math.max(...analytics.activity.map((entry) => entry.messages), 1));
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Activity</h3>
      <p class="mt-0.5 text-meta text-text-muted">Click a day to narrow the dashboard to that date.</p>
    </div>
    {#if analytics.coverage.activity}
      <span class="tabular font-mono text-meta text-text-faint">{analytics.coverage.activity.included_sessions} sessions in range</span>
    {/if}
  </div>

  {#if analytics.loading.activity}
    <div class="py-12 text-center text-meta text-text-muted">Loading activity…</div>
  {:else if analytics.errors.activity}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.activity}</div>
  {:else if analytics.activity.length > 0}
    <div class="space-y-2">
      <div class="flex h-36 items-end gap-1">
        {#each analytics.activity as day}
          <button
            class="flex-1 rounded-t-sm bg-accent/60 transition-colors hover:bg-accent"
            style={`height:${Math.max((day.messages / maxMessages) * 100, 4)}%`}
            title={`${day.date}: ${day.messages} messages, ${day.sessions} sessions`}
            onclick={() => analytics.drillDownToDay(day.date)}
          >
            <span class="sr-only">{day.date}</span>
          </button>
        {/each}
      </div>
      <div class="flex justify-between tabular font-mono text-meta text-text-faint">
        <span>{analytics.activity[0]?.date}</span>
        <span>{analytics.activity[analytics.activity.length - 1]?.date}</span>
      </div>
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No activity in the selected range.</div>
  {/if}
</section>
