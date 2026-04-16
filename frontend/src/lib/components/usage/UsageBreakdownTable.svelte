<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';
  import type {
    UsageProjectBreakdown,
    UsageModelBreakdown,
    UsageAgentBreakdown,
  } from '../../api/client';

  let {
    title,
    kind,
    rows,
    loading = false,
    error = null,
  }: {
    title: string;
    kind: 'project' | 'model' | 'agent';
    rows: Array<UsageProjectBreakdown | UsageModelBreakdown | UsageAgentBreakdown>;
    loading?: boolean;
    error?: string | null;
  } = $props();

  function labelForRow(row: UsageProjectBreakdown | UsageModelBreakdown | UsageAgentBreakdown): string {
    if ('project' in row) return row.project;
    if ('model' in row) return row.model;
    return row.agent;
  }

  function handleSelect(row: UsageProjectBreakdown | UsageModelBreakdown | UsageAgentBreakdown): void {
    if (kind === 'project' && 'project' in row) {
      void usage.setProject(row.project === 'unknown' ? '' : row.project);
    } else if (kind === 'agent' && 'agent' in row) {
      void usage.setAgent(row.agent);
    }
  }

  const helperText = $derived.by(() => {
    if (kind === 'project') return 'Click a project row to filter the page.';
    if (kind === 'agent') return 'Click an agent row to filter the page.';
    return 'Model totals are event-derived and not currently filterable.';
  });
</script>

<section class="rounded-xl border border-gray-800 bg-gray-950/60 p-4">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-white">{title}</h2>
      <p class="mt-1 text-xs text-gray-500">{helperText}</p>
    </div>
  </div>

  {#if loading}
    <div class="mt-4 space-y-3">
      {#each Array.from({ length: 5 }) as _}
        <div class="h-12 animate-pulse rounded-lg bg-gray-900"></div>
      {/each}
    </div>
  {:else if error}
    <div class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      {error}
    </div>
  {:else if rows.length === 0}
    <div class="mt-4 rounded-lg border border-dashed border-gray-800 px-4 py-10 text-center text-sm text-gray-500">
      No usage rows for this slice.
    </div>
  {:else}
    <div class="mt-4 space-y-2">
      {#each rows as row}
        <button
          class="block w-full rounded-lg border border-transparent px-3 py-3 text-left transition {kind === 'model' ? 'cursor-default hover:border-transparent hover:bg-transparent' : 'hover:border-gray-700 hover:bg-gray-900/60'}"
          disabled={kind === 'model'}
          onclick={() => handleSelect(row)}
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium text-white">{labelForRow(row)}</div>
              <div class="mt-1 text-xs text-gray-500">
                {formatNumber(row.usage_events)} usage events • {formatNumber(row.session_count)} session{row.session_count === 1 ? '' : 's'}
              </div>
            </div>
            <div class="text-right">
              <div class="text-sm font-medium text-emerald-300">{formatCost(row.cost_usd)}</div>
              <div class="mt-1 text-xs text-gray-500">
                {formatNumber(row.input_tokens + row.output_tokens)} tokens
              </div>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</section>
