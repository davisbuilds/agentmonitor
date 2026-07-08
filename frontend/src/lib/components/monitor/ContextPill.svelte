<script lang="ts">
  import { formatNumber } from '../../format';
  import { Bar } from '../ui';

  interface Props {
    pct: number | null;
    usedTokens?: number | null;
    windowTokens?: number | null;
    // Show a full used/window readout + bar (detail/inspector) vs a compact
    // dot+percent chip (cards).
    variant?: 'compact' | 'full';
    class?: string;
  }

  const { pct, usedTokens = null, windowTokens = null, variant = 'compact', class: klass = '' }: Props = $props();

  // pct is USED percent, so higher is more constrained (mirrors QuotaPill).
  function dotColor(usedPercent: number): string {
    if (usedPercent >= 85) return 'bg-danger';
    if (usedPercent >= 60) return 'bg-warn';
    return 'bg-ok';
  }

  const title = $derived(
    usedTokens != null && windowTokens != null
      ? `Context: ${formatNumber(usedTokens)} / ${formatNumber(windowTokens)} tokens`
      : 'Context window occupancy',
  );
</script>

{#if pct != null}
  {#if variant === 'full'}
    <div class="flex items-center gap-2.5 text-meta {klass}" {title}>
      <span class="text-text-faint">Context</span>
      <Bar value={pct} tone="auto" class="flex-1" />
      <span class="tabular shrink-0 font-mono text-text-muted">{pct}%</span>
      {#if usedTokens != null && windowTokens != null}
        <span class="tabular shrink-0 font-mono text-text-faint">
          {formatNumber(usedTokens)}/{formatNumber(windowTokens)}
        </span>
      {/if}
    </div>
  {:else}
    <span class="flex items-center gap-1.5 {klass}" {title}>
      <span class="h-1.5 w-1.5 rounded-full {dotColor(pct)}"></span>
      <span class="tabular font-mono text-text-muted">{pct}%</span>
    </span>
  {/if}
{/if}
