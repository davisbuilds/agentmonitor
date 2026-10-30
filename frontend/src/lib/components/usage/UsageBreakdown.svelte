<script lang="ts">
  import { Bar, DataTable, InfoTip } from '../ui';
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatDateRange, formatNumber } from '../../format';
  import { BREAKDOWN_DIMENSIONS, breakdownRows, type BreakdownDimension, type BreakdownRow } from '../../usage-breakdown';

  let dimension = $state<BreakdownDimension>('model');

  const panel = { model: 'models', project: 'projects', agent: 'agents', tier: 'tiers' } as const;
  const loading = $derived(usage.loading[panel[dimension]]);
  const error = $derived(usage.errors[panel[dimension]]);
  const rows = $derived(breakdownRows(dimension, usage, usage.priorCosts));
  const maxCost = $derived(rows.reduce((max, row) => Math.max(max, row.cost), 0));
  const priorRange = $derived(usage.priorCosts?.range ?? null);

  const columns = [
    { key: 'label', label: 'Name' },
    { key: 'cost', label: 'Cost', numeric: true, width: '8rem' },
    { key: 'share', label: 'Share', numeric: true, width: '5rem' },
    { key: 'change', label: 'vs before', numeric: true, width: '6rem' },
    { key: 'tokens', label: 'All tokens', numeric: true, width: '7rem' },
    { key: 'sessions', label: 'Sessions', numeric: true, width: '6rem' },
  ];

  const toneClass = { ok: 'text-ok', danger: 'text-danger', muted: 'text-text-faint' } as const;

  function select(row: BreakdownRow): void {
    if (row.filter?.kind === 'project') void usage.setProject(row.filter.value);
    else if (row.filter?.kind === 'agent') void usage.setAgent(row.filter.value);
  }
</script>

<!-- The Model view doubles as the daily chart's accessible table. -->
<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="usage-breakdown-heading">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex items-center gap-1.5">
      <h3 id="usage-breakdown-heading" class="text-h3">Breakdown</h3>
      <InfoTip label="Breakdown">
        <p>The range's cost and tokens by model, project, agent, or pricing tier. Share is of the range's cost; "vs before" compares each row's cost with the period just before{#if priorRange} ({formatDateRange(priorRange.from, priorRange.to)}){/if}. Select a project or agent to narrow the page.</p>
      </InfoTip>
    </div>

    <div class="flex shrink-0 rounded-sm border border-line" role="group" aria-label="Break down by">
      {#each BREAKDOWN_DIMENSIONS as option}
        <button
          class="px-2 py-1 text-meta transition-colors first:rounded-l-sm last:rounded-r-sm
            {dimension === option.id ? 'bg-surface-2 text-text' : 'text-text-faint hover:text-text-muted'}"
          aria-pressed={dimension === option.id}
          onclick={() => (dimension = option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  {#if loading}
    <div class="mt-4 space-y-2">
      {#each Array.from({ length: 5 }) as _}
        <div class="h-10 animate-pulse rounded-sm bg-surface-2"></div>
      {/each}
    </div>
  {:else if error}
    <div class="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">{error}</div>
  {:else}
    <DataTable class="mt-3 max-h-[28rem] overflow-y-auto" {columns} {rows} rowKey={(row) => row.key} empty="No usage rows for this slice.">
      {#snippet cell(row, column)}
        {#if column.key === 'label'}
          <div class="min-w-0">
            <div class="flex items-baseline gap-2">
              {#if row.filter}
                <button
                  class="truncate text-body font-medium text-text hover:text-accent focus-visible:text-accent"
                  title={`Narrow the page to ${row.label}`}
                  onclick={() => select(row)}
                >{row.label}</button>
              {:else}
                <span class="truncate text-body font-medium text-text" title={row.title}>{row.label}</span>
              {/if}
              {#if row.note}<span class="shrink-0 text-meta text-warn">{row.note}</span>{/if}
            </div>
            <Bar class="mt-1.5 h-1 max-w-64" value={row.cost} max={maxCost} />
          </div>
        {:else if column.key === 'cost'}
          {formatCost(row.cost)}
        {:else if column.key === 'share'}
          <span class="text-text-muted">{row.share === null ? '—' : `${Math.round(row.share * 100)}%`}</span>
        {:else if column.key === 'change'}
          {#if row.change}<span class={toneClass[row.change.tone]}>{row.change.value}</span>{:else}<span class="text-text-faint">—</span>{/if}
        {:else if column.key === 'tokens'}
          <span class="text-text-muted" title={row.tokenSplit}>{formatNumber(row.tokens)}</span>
        {:else if column.key === 'sessions'}
          <span class="text-text-muted">{formatNumber(row.sessions)}</span>
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>
