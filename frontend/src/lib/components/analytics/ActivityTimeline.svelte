<script lang="ts">
  import { InfoTip } from '../ui';
  import { DailyBarChart, type DailyBar } from '../ui/chart';
  import { analytics } from '../../stores/analytics.svelte';
  import { activityBars } from '../../activity-bars';

  const chart = $derived(activityBars(analytics.activity));
  const messagesByDate = $derived(new Map(analytics.activity.map(point => [point.date, point.messages])));

  function label(day: DailyBar): string {
    const sessions = day.segments[0]?.value ?? 0;
    const messages = messagesByDate.get(day.date) ?? 0;
    return `${day.date}: ${sessions} session${sessions === 1 ? '' : 's'}, ${messages} message${messages === 1 ? '' : 's'}`;
  }
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
    <DailyBarChart days={chart.days} {label} integer onSelect={(date) => analytics.drillDownToDay(date)} />
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No activity in the selected range.</div>
  {/if}
</section>
