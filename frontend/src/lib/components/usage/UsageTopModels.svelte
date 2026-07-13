<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';
  import type { UsageModelBreakdown, UsageModelDailyPoint } from '../../api/client';

  type Metric = 'cost' | 'tokens';

  const TOP_N = 5;

  // Validated against the dark chart surface (#101419): lightness band, chroma
  // floor, adjacent-pair CVD separation (worst ΔE 15.7), and 3:1 contrast all pass.
  // Order is the CVD-safety mechanism, not cosmetic — do not reshuffle without
  // re-validating. Green and red are omitted deliberately: they read as the
  // reserved ok/danger status tokens.
  const SERIES_COLORS = ['#3987e5', '#199e70', '#c98500', '#d55181', '#9085e9', '#d95926'];
  const OTHER_COLOR = '#82878c';
  const OTHER_LABEL = 'Other';

  let metric = $state<Metric>('cost');

  function measure(slice: UsageModelBreakdown, m: Metric): number {
    return m === 'cost' ? slice.cost_usd : slice.input_tokens + slice.output_tokens;
  }

  function formatMetric(value: number, m: Metric): string {
    return m === 'cost' ? formatCost(value) : `${formatNumber(value)} tokens`;
  }

  /**
   * Hues are keyed to the range's models ranked by cost — deliberately NOT by the
   * selected metric and NOT by the top-N set. Both would make a series' color
   * depend on its rank, so toggling to Tokens would repaint the survivors. Ranking
   * a fixed universe hands each model its own slot, so a hue means one model for
   * as long as the range holds, and two series can never share one.
   */
  const colorByModel = $derived.by(() => {
    const costTotals = new Map<string, number>();
    for (const point of usage.modelsDaily) {
      for (const slice of point.models) {
        costTotals.set(slice.model, (costTotals.get(slice.model) ?? 0) + slice.cost_usd);
      }
    }

    const ranked = [...costTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, SERIES_COLORS.length);

    return new Map(ranked.map(([model], index) => [model, SERIES_COLORS[index]]));
  });

  function colorFor(model: string): string {
    return colorByModel.get(model) ?? OTHER_COLOR;
  }

  /** Models ranked over the whole range, so stack order is stable across days. */
  const topModels = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const point of usage.modelsDaily) {
      for (const slice of point.models) {
        totals.set(slice.model, (totals.get(slice.model) ?? 0) + measure(slice, metric));
      }
    }
    return [...totals.entries()]
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_N)
      .map(([model]) => model);
  });

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

<section class="flex h-full flex-col rounded-lg border border-line bg-surface p-4 xl:max-h-[34rem]">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-h3">Top Models</h3>
      <p class="mt-0.5 text-meta text-text-muted">
        Model mix by day. Click a day to drill the page into it.
      </p>
    </div>

    <div class="flex shrink-0 rounded-sm border border-line" role="group" aria-label="Metric">
      {#each [{ id: 'cost', label: 'Cost' }, { id: 'tokens', label: 'Tokens' }] as option}
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
  {:else if rangeTotal === 0}
    <div class="mt-4 flex flex-1 items-center justify-center rounded-sm border border-dashed border-line px-4 py-10 text-center text-meta text-text-faint">
      No model usage for this range.
    </div>
  {:else}
    <ul class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {#each legend as model}
        <li class="flex items-center gap-1.5 text-meta text-text-muted">
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-[2px]"
            style={`background:${colorFor(model)}`}
            aria-hidden="true"
          ></span>
          <span class="font-mono">{model}</span>
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
              title={`${row.date} · ${formatMetric(row.total, metric)}`}
              aria-label={`${row.date}: ${formatMetric(row.total, metric)}`}
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
                      title={`${row.date} · ${segment.model} · ${formatMetric(segment.value, metric)} (${Math.round((segment.value / row.total) * 100)}%)`}
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
