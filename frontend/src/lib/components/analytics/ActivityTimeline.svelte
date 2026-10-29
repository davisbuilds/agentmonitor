<script lang="ts">
  import { InfoTip } from '../ui';
  import { analytics } from '../../stores/analytics.svelte';
  import { activityBars } from '../../activity-bars';

  const chart = $derived(activityBars(analytics.activity));
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <div class="flex items-center gap-1.5">
        <h3 class="text-h3">Activity</h3>
        <InfoTip label="Activity"><p>Sessions per day, by the day each started. Subagents and Codex app jobs are not sessions of their own; their messages still count. Click a day to narrow the page to it.</p></InfoTip>
      </div>
    </div>
    {#if chart.maxSessions > 0}
      <span class="tabular font-mono text-meta text-text-faint">{chart.totalSessions} session{chart.totalSessions === 1 ? '' : 's'} in range</span>
    {/if}
  </div>

  {#if analytics.loading.activity}
    <div class="py-12 text-center text-meta text-text-muted">Loading activity…</div>
  {:else if analytics.errors.activity}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.activity}</div>
  {:else if chart.maxSessions > 0}
    <div class="space-y-2">
      <div class="flex gap-2">
        <!-- The axis names the busiest day's sessions at the top and zero at the baseline. -->
        <div class="flex h-36 w-6 shrink-0 flex-col justify-between text-right tabular font-mono text-meta text-text-faint" aria-hidden="true">
          <span>{chart.maxSessions}</span>
          <span>0</span>
        </div>
        <div class="flex h-36 min-w-0 flex-1 items-end gap-px border-b border-line">
          {#each chart.bars as day}
            <button
              class="group h-full flex-1 rounded-t-sm transition-colors hover:bg-surface-2"
              title={`${day.date}: ${day.sessions} session${day.sessions === 1 ? '' : 's'}, ${day.messages} messages`}
              onclick={() => analytics.drillDownToDay(day.date)}
            >
              <span class="sr-only">{day.date}: {day.sessions} sessions</span>
              <span class="flex h-full items-end" aria-hidden="true">
                {#if day.sessions > 0}
                  <!-- At least 2px, so a quiet day still reads as active. -->
                  <span class="block w-full rounded-t-sm bg-accent/60 transition-colors group-hover:bg-accent" style={`height:max(${day.heightPct}%, 2px)`}></span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
      <div class="ml-8 flex justify-between tabular font-mono text-meta text-text-faint">
        <span>{chart.bars[0]?.date}</span>
        <span>{chart.bars[chart.bars.length - 1]?.date}</span>
      </div>
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No activity in the selected range.</div>
  {/if}
</section>
