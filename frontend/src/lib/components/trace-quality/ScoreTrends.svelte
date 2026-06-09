<script lang="ts">
  import { Select, EmptyState } from '../ui';
  import type {
    TraceQualityScoreSummary,
    TraceQualityScoreRollups,
    TraceQualityScoreRollupDimension,
  } from '../../api/client';

  interface Props {
    summary: TraceQualityScoreSummary[];
    rollups: TraceQualityScoreRollups;
  }

  let { summary, rollups }: Props = $props();

  const DIMENSION_OPTIONS: Array<{ value: TraceQualityScoreRollupDimension; label: string }> = [
    { value: 'day', label: 'By day' },
    { value: 'model', label: 'By model' },
    { value: 'tool', label: 'By tool' },
    { value: 'prompt', label: 'By prompt' },
    { value: 'session', label: 'By session' },
    { value: 'trace', label: 'By trace' },
  ];

  let dimension = $state<TraceQualityScoreRollupDimension>('day');
  const rows = $derived(rollups[dimension] ?? []);

  function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }
  function formatScore(value: number | null): string {
    return value == null ? '—' : value.toFixed(2);
  }
  function summaryValue(row: TraceQualityScoreSummary): string {
    if (row.value_type === 'numeric') {
      const avg = row.numeric_avg == null ? '—' : row.numeric_avg.toFixed(2);
      if (row.numeric_min == null || row.numeric_max == null) return avg;
      return `${avg} (${row.numeric_min.toFixed(2)}–${row.numeric_max.toFixed(2)})`;
    }
    if (row.value_type === 'boolean') return `${row.boolean_true} pass / ${row.boolean_false} fail`;
    if (row.value_type === 'categorical') {
      const parts = Object.entries(row.categorical_values).map(([k, v]) => `${k}: ${v}`);
      return parts.length ? parts.join(', ') : '—';
    }
    return `${row.count} note${row.count === 1 ? '' : 's'}`;
  }
</script>

<section class="space-y-3">
  <h3 class="text-h3">Score trends</h3>

  {#if summary.length === 0}
    <EmptyState title="No local scores in this window." description="Attach review scores in the explorer, or run deterministic evaluators, to populate score trends." />
  {:else}
    <!-- Summary by score name -->
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {#each summary as row (`${row.name}-${row.value_type}`)}
        <div class="rounded-sm border border-line bg-surface px-3 py-2.5">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-meta font-medium text-text">{row.name}</span>
            <span class="shrink-0 text-meta text-text-faint">{row.value_type}</span>
          </div>
          <div class="mt-1 font-mono tabular text-body text-text">{summaryValue(row)}</div>
          <div class="mt-0.5 text-meta text-text-faint">{formatNumber(row.count)} scores · {formatNumber(row.scored_traces)} traces</div>
        </div>
      {/each}
    </div>

    <!-- Rollups by dimension -->
    <div class="flex items-center justify-between gap-2">
      <h4 class="text-meta font-medium text-text">Rollup</h4>
      <Select
        value={dimension}
        options={DIMENSION_OPTIONS}
        aria-label="Score rollup dimension"
        onchange={(value) => (dimension = value as TraceQualityScoreRollupDimension)}
      />
    </div>

    {#if rows.length === 0}
      <p class="text-meta text-text-faint">No scores rolled up for this dimension.</p>
    {:else}
      <div class="overflow-x-auto rounded-lg border border-line bg-surface">
        <table class="w-full min-w-[40rem] border-collapse text-meta">
          <thead>
            <tr class="border-b border-line text-left text-text-faint">
              <th class="px-3 py-2 font-medium">{DIMENSION_OPTIONS.find((d) => d.value === dimension)?.label}</th>
              <th class="px-3 py-2 text-right font-medium">Scores</th>
              <th class="px-3 py-2 text-right font-medium">Avg (numeric)</th>
              <th class="px-3 py-2 text-right font-medium">Pass/Fail</th>
              <th class="px-3 py-2 text-right font-medium">Traces</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.key)}
              <tr class="border-b border-line/60 last:border-0 hover:bg-surface-2">
                <td class="px-3 py-2 text-text-muted"><span class="font-mono">{row.label ?? row.key}</span></td>
                <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatNumber(row.score_count)}</td>
                <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatScore(row.numeric_avg)}</td>
                <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{row.boolean_true}/{row.boolean_false}</td>
                <td class="px-3 py-2 text-right font-mono tabular text-text-faint">{formatNumber(row.trace_count)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</section>
