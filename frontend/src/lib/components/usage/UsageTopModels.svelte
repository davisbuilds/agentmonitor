<script lang="ts">
  import { InfoTip } from '../ui';
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatModelName, formatNumber } from '../../format';
  import type { UsageDailyPoint, UsageModelDailyPoint } from '../../api/client';
  import {
    assignModelColors,
    measure,
    rankModels,
    OTHER_COLOR,
    OTHER_LABEL,
    type UsageMetric as Metric,
  } from './model-colors';

  let metric = $state<Metric>('cost');

  function formatMetric(value: number, m: Metric): string {
    return m === 'cost' ? formatCost(value) : `${formatNumber(value)} tokens`;
  }

  const topModels = $derived(rankModels(usage.modelsDaily, metric));
  const colorByModel = $derived(assignModelColors(usage.modelsDaily));

  /** Gray is reserved for the aggregated Other series; every named model has a hue. */
  function colorFor(model: string): string {
    return colorByModel.get(model) ?? OTHER_COLOR;
  }

  const hasOther = $derived.by(() =>
    usage.modelsDaily.some(point =>
      point.models.some(slice => measure(slice, metric) > 0 && !topModels.includes(slice.model)),
    ),
  );

  const legend = $derived(hasOther ? [...topModels, OTHER_LABEL] : topModels);

  type Segment = { model: string; value: number };
  type Row = { date: string; total: number; segments: Segment[] };

  const rows = $derived.by((): Row[] =>
    usage.modelsDaily.map((point: UsageModelDailyPoint) => {
      const byModel = new Map<string, number>();
      let other = 0;
      for (const slice of point.models) {
        const value = measure(slice, metric);
        if (value <= 0) continue;
        if (topModels.includes(slice.model)) {
          byModel.set(slice.model, (byModel.get(slice.model) ?? 0) + value);
        } else {
          other += value;
        }
      }

      // Follow the range-wide ranking so a model keeps its slot in every stack.
      const segments = topModels
        .filter(model => (byModel.get(model) ?? 0) > 0)
        .map(model => ({ model, value: byModel.get(model) as number }));
      if (other > 0) segments.push({ model: OTHER_LABEL, value: other });

      return {
        date: point.date,
        total: segments.reduce((sum, segment) => sum + segment.value, 0),
        segments,
      };
    }),
  );

  const maxTotal = $derived(rows.reduce((max, row) => Math.max(max, row.total), 0));
  const rangeTotal = $derived(rows.reduce((sum, row) => sum + row.total, 0));
  // Empty only when there is no usage at all: unpriced models record tokens at
  // $0, and their days must still show under the Cost view.
  const anyUsage = $derived(
    usage.modelsDaily.some(point => point.models.some(slice => measure(slice, 'cost') > 0 || measure(slice, 'tokens') > 0)),
  );

  // The day's totals, from the daily series, so each bar says what the old
  // Daily Usage list did.
  const dailyByDate = $derived(new Map(usage.daily.map((row: UsageDailyPoint) => [row.date, row])));
  function dayLabel(row: Row): string {
    const day = dailyByDate.get(row.date);
    if (!day) return `${row.date}: ${formatMetric(row.total, metric)}`;
    const tokens = day.input_tokens + day.output_tokens + day.cache_read_tokens + day.cache_write_tokens;
    return [
      `${row.date}: ${formatCost(day.cost_usd)}`,
      `${formatNumber(tokens)} tokens`,
      `${formatNumber(day.usage_events)} usage event${day.usage_events === 1 ? '' : 's'}`,
      `${formatNumber(day.session_count)} session${day.session_count === 1 ? '' : 's'}`,
    ].join(' · ');
  }

  function shortDate(date: string): string {
    return date.slice(5).replace('-', '/');
  }

  /**
   * Label a handful of columns, never all of them — a tick under every day
   * collides on a 30-day range. Always anchor the first and last.
   */
  const tickIndexes = $derived.by(() => {
    const count = rows.length;
    if (count === 0) return new Set<number>();
    const target = Math.min(6, count);
    const step = Math.max(1, Math.round((count - 1) / Math.max(1, target - 1)));
    const ticks = new Set<number>();
    for (let i = 0; i < count; i += step) ticks.add(i);
    ticks.add(count - 1);
    return ticks;
  });
</script>

<section
  class="flex h-full flex-col rounded-lg border border-line bg-surface p-4 xl:max-h-[34rem]"
  aria-labelledby="usage-daily-heading"
>
  <div class="flex items-start justify-between gap-3">
    <div>
      <div class="flex items-center gap-1.5">
        <h3 id="usage-daily-heading" class="text-h3">Daily Usage by Model</h3>
        <InfoTip label="Daily Usage by Model"><p>Cost or tokens per day by event time, split by the top models. Token totals include cache reads and writes. Point at a day for its totals; click it to narrow the page to that day.</p></InfoTip>
      </div>
    </div>

    <div class="flex shrink-0 rounded-sm border border-line" role="group" aria-label="Metric">
      {#each [{ id: 'cost', label: 'Cost' }, { id: 'tokens', label: 'All tokens' }] as option}
        <button
          class="px-2 py-1 text-meta transition-colors first:rounded-l-sm last:rounded-r-sm
            {metric === option.id ? 'bg-surface-2 text-text' : 'text-text-faint hover:text-text-muted'}"
          aria-pressed={metric === option.id}
          onclick={() => (metric = option.id as Metric)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  {#if usage.loading.modelsDaily}
    <div class="mt-4 flex min-h-[15rem] flex-1 gap-2">
      <div class="w-16 shrink-0" aria-hidden="true"></div>
      <div class="flex min-w-0 flex-1 items-end gap-[2px] border-b border-line pb-px">
        {#each [40, 65, 30, 80, 55, 70, 45, 90, 60, 35, 75, 50] as height}
          <div
            class="flex-1 animate-pulse rounded-t-[4px] bg-surface-2"
            style={`height:${height}%`}
          ></div>
        {/each}
      </div>
    </div>
  {:else if usage.errors.modelsDaily}
    <div class="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">
      {usage.errors.modelsDaily}
    </div>
  {:else if !anyUsage}
    <div class="mt-4 flex flex-1 items-center justify-center rounded-sm border border-dashed border-line px-4 py-10 text-center text-meta text-text-faint">
      No model usage for this range.
    </div>
  {:else}
    {#if rangeTotal === 0}
      <p class="mt-3 text-meta text-text-faint">
        No cost recorded in this range; unpriced models bill as $0. Switch to All tokens to see the usage.
      </p>
    {/if}
    <ul class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {#each legend as model}
        <li class="flex items-center gap-1.5 text-meta text-text-muted">
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-[2px]"
            style={`background:${colorFor(model)}`}
            aria-hidden="true"
          ></span>
          <span class="font-mono" title={model}>{formatModelName(model)}</span>
        </li>
      {/each}
    </ul>

    <div class="mt-4 flex min-h-[15rem] flex-1 flex-col">
      <div class="flex min-h-0 flex-1 gap-2">
        <!-- y-axis: just the extremes; a full gridded scale would out-shout the data -->
        <div class="flex w-16 shrink-0 flex-col justify-between text-right text-meta tabular font-mono text-text-faint">
          <span>{formatMetric(maxTotal, metric)}</span>
          <span>0</span>
        </div>

        <div class="flex min-w-0 flex-1 items-end gap-[2px] border-b border-line pb-px">
          {#each rows as row}
            <button
              class="group flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-sm transition-colors hover:bg-surface-2"
              onclick={() => usage.setDateRange(row.date, row.date)}
              title={dayLabel(row)}
              aria-label={dayLabel(row)}
            >
              {#if row.total > 0}
                <div
                  class="flex w-full flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                  style={`height:${Math.max((row.total / maxTotal) * 100, 1)}%`}
                >
                  {#each row.segments as segment}
                    <div
                      class="w-full"
                      style={`background:${colorFor(segment.model)}; flex:${segment.value} 1 0; min-height:2px`}
                      title={`${row.date} · ${formatModelName(segment.model)} · ${formatMetric(segment.value, metric)} (${Math.round((segment.value / row.total) * 100)}%)`}
                    ></div>
                  {/each}
                </div>
              {:else}
                <div class="h-px w-full bg-line" aria-hidden="true"></div>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <div class="flex gap-2 pt-1.5">
        <div class="w-16 shrink-0" aria-hidden="true"></div>
        <div class="flex min-w-0 flex-1 gap-[2px]">
          {#each rows as row, index}
            <span class="min-w-0 flex-1 text-center text-meta tabular font-mono text-text-faint">
              {tickIndexes.has(index) ? shortDate(row.date) : ''}
            </span>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</section>
