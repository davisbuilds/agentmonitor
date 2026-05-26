<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';
  import type {
    UsageProjectBreakdown,
    UsageModelBreakdown,
    UsageTierBreakdown,
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
    kind: 'project' | 'model' | 'tier' | 'agent';
    rows: Array<UsageProjectBreakdown | UsageModelBreakdown | UsageTierBreakdown | UsageAgentBreakdown>;
    loading?: boolean;
    error?: string | null;
  } = $props();

  function labelForRow(row: UsageProjectBreakdown | UsageModelBreakdown | UsageTierBreakdown | UsageAgentBreakdown): string {
    if ('project' in row) return row.project;
    if ('model' in row) return row.model;
    if ('tier' in row) return `${row.provider} / ${row.tier}`;
    return row.agent;
  }

  function detailForRow(row: UsageProjectBreakdown | UsageModelBreakdown | UsageTierBreakdown | UsageAgentBreakdown): string {
    const base = `${formatNumber(row.usage_events)} usage events • ${formatNumber(row.session_count)} session${row.session_count === 1 ? '' : 's'}`;
    if ('pricing_status' in row && row.pricing_status !== 'known') return `${base} • ${row.pricing_status}`;
    if ('unknown_model_events' in row && row.unknown_model_events > 0) return `${base} • ${formatNumber(row.unknown_model_events)} unknown`;
    return base;
  }

  function handleSelect(row: UsageProjectBreakdown | UsageModelBreakdown | UsageTierBreakdown | UsageAgentBreakdown): void {
    if (kind === 'project' && 'project' in row) {
      void usage.setProject(row.project === 'unknown' ? '' : row.project);
    } else if (kind === 'agent' && 'agent' in row) {
      void usage.setAgent(row.agent);
    }
  }

  const helperText = $derived.by(() => {
    if (kind === 'project') return 'Click a project row to filter the page.';
    if (kind === 'agent') return 'Click an agent row to filter the page.';
    if (kind === 'tier') return 'Tier totals are provider-neutral rollups from classified usage events.';
    return 'Use the model filter above to narrow this table.';
  });
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div>
    <h3 class="text-h3">{title}</h3>
    <p class="mt-0.5 text-meta text-text-muted">{helperText}</p>
  </div>

  {#if loading}
    <div class="mt-4 space-y-2">
      {#each Array.from({ length: 5 }) as _}
        <div class="h-12 animate-pulse rounded-sm bg-surface-2"></div>
      {/each}
    </div>
  {:else if error}
    <div class="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">
      {error}
    </div>
  {:else if rows.length === 0}
    <div class="mt-4 rounded-sm border border-dashed border-line px-4 py-10 text-center text-meta text-text-faint">
      No usage rows for this slice.
    </div>
  {:else}
    <div class="mt-4 divide-y divide-line/60">
      {#each rows as row}
        <button
          class="block w-full rounded-sm border border-transparent px-3 py-2.5 text-left transition-colors {kind === 'model' || kind === 'tier' ? 'cursor-default' : 'hover:bg-surface-2'}"
          disabled={kind === 'model' || kind === 'tier'}
          onclick={() => handleSelect(row)}
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-body font-medium text-text">{labelForRow(row)}</div>
              <div class="mt-0.5 text-meta text-text-faint">
                {detailForRow(row)}
              </div>
            </div>
            <div class="text-right">
              <div class="tabular font-mono text-body text-ok">{formatCost(row.cost_usd)}</div>
              <div class="mt-0.5 tabular font-mono text-meta text-text-faint">
                {formatNumber(row.input_tokens + row.output_tokens)} tokens
              </div>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</section>
