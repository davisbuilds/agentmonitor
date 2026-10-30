<script lang="ts">
  import { InfoTip } from '../ui';
  import { DailyBarChart, formatUsd, type DailyBar } from '../ui/chart';
  import { analytics } from '../../stores/analytics.svelte';
  import { formatCost, formatNumber } from '../../format';
  import { DELEGATION_COLORS, DELEGATION_METRICS, delegationBars, type DelegationMetric } from '../../delegation-bars';

  let metric = $state<DelegationMetric>('sessions');
  const chart = $derived(delegationBars(analytics.delegation, metric));
  const hasWork = $derived(chart.started + chart.delegated > 0);

  const formatValue = (value: number) => (metric === 'cost_usd' ? formatCost(value) : formatNumber(value));
  const noun = $derived(DELEGATION_METRICS.find(option => option.id === metric)!.label.toLowerCase());

  function label(day: DailyBar): string {
    const split = chart.byDate.get(day.date);
    if (!split) return day.date;
    return `${day.date}: ${formatValue(split.started)} started, ${formatValue(split.subagent + split.internal)} delegated (${noun})`;
  }
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="delegated-work-heading">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-1.5">
      <h3 id="delegated-work-heading" class="text-h3">Delegated Work</h3>
      <InfoTip label="Delegated Work">
        <p>Each day's work split by who did it: sessions someone started, or work they delegated, meaning the subagents a session spawned and Codex's own threads (approval reviews, app jobs). Sessions and messages count by the day a session started, as Activity does; cost by the day it was spent, as Usage does. Click a day to narrow the page to it.</p>
      </InfoTip>
    </div>

    <div class="flex shrink-0 rounded-sm border border-line" role="group" aria-label="Measure">
      {#each DELEGATION_METRICS as option}
        <button
          class="px-2 py-1 text-meta transition-colors first:rounded-l-sm last:rounded-r-sm
            {metric === option.id ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text'}"
          aria-pressed={metric === option.id}
          onclick={() => (metric = option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  {#if analytics.loading.delegation && !analytics.delegation}
    <div class="py-12 text-center text-meta text-text-muted">Loading delegated work…</div>
  {:else if analytics.errors.delegation}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.delegation}</div>
  {:else if hasWork}
    <div class="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-meta text-text-muted">
      <span><span class="tabular font-mono text-h3 text-text">{chart.share === null ? '—' : `${Math.round(chart.share * 100)}%`}</span> of {noun} delegated</span>
      <span class="flex items-center gap-x-4">
        <span class="flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-[2px]" style={`background:${DELEGATION_COLORS.started}`} aria-hidden="true"></span>
          Started <span class="tabular font-mono text-text">{formatValue(chart.started)}</span>
        </span>
        <span class="flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-[2px]" style={`background:${DELEGATION_COLORS.delegated}`} aria-hidden="true"></span>
          Delegated <span class="tabular font-mono text-text">{formatValue(chart.delegated)}</span>
        </span>
      </span>
    </div>

    <DailyBarChart
      days={chart.days}
      {label}
      integer={metric !== 'cost_usd'}
      axisClass={metric === 'cost_usd' ? 'w-12' : 'w-8'}
      formatTick={(value) => (metric === 'cost_usd' ? formatUsd(value) : formatNumber(value))}
      onSelect={(date) => analytics.drillDownToDay(date)}
    >
      {#snippet tooltip(bar)}
        {@const split = chart.byDate.get(bar.date)}
        <div class="mb-2 text-body font-medium text-text">{bar.date}</div>
        {#if split}
          {@const total = split.started + split.subagent + split.internal}
          {@const percent = (value: number) => (total > 0 ? ` · ${Math.round((value / total) * 100)}%` : '')}
          <div class="space-y-1">
            {#each [
              { key: 'Started', value: split.started, color: DELEGATION_COLORS.started },
              { key: 'Delegated', value: split.subagent + split.internal, color: DELEGATION_COLORS.delegated },
            ] as row (row.key)}
              <div class="flex items-center justify-between gap-3">
                <span class="flex items-center gap-2 text-text-muted">
                  <span class="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={`background:${row.color}`}></span>
                  {row.key}
                </span>
                <span class="tabular font-mono text-text">{formatValue(row.value)}{percent(row.value)}</span>
              </div>
            {/each}
            <!-- The delegated segment's two parts, under it. -->
            {#each [{ key: 'Subagents', value: split.subagent }, { key: 'Codex threads', value: split.internal }] as part (part.key)}
              <div class="flex items-center justify-between gap-3 pl-[18px] text-text-muted">
                <span>{part.key}</span>
                <span class="tabular font-mono">{formatValue(part.value)}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/snippet}
    </DailyBarChart>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No {noun} in the selected range.</div>
  {/if}
</section>
