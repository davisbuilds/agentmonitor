<script lang="ts">
  import type { TraceQualityTrace } from '../../api/client';
  import { traceCoveragePills, type TraceCoverageTone } from '../../trace-coverage';

  interface Props {
    trace: TraceQualityTrace;
    /** List rows show only a score; the detail view lists what was captured. */
    compact?: boolean;
  }

  let { trace, compact = false }: Props = $props();

  const pills = $derived(traceCoveragePills(trace.coverage));
  const scored = $derived(trace.score_count > 0);

  const DOT_CLASS: Record<TraceCoverageTone, string> = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    neutral: 'bg-line-strong',
  };
</script>

<!-- WHY: Many summary rows omit the transcript flag even when a transcript exists. Missing metadata must not be labeled summary-only. -->
{#if compact}
  {#if scored}
    <div class="mt-1.5 inline-flex items-center gap-1.5 text-meta text-text-faint">
      <span class="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true"></span>Scored
    </div>
  {/if}
{:else}
  <div class="flex flex-wrap items-center gap-3 text-meta text-text-muted">
    {#each pills as item (item.key)}
      <span class="inline-flex items-center gap-1.5 {item.tone === 'neutral' ? 'text-text-faint' : ''}">
        <span class="h-1.5 w-1.5 rounded-full {DOT_CLASS[item.tone]}" aria-hidden="true"></span>
        {item.label}
      </span>
    {/each}
    {#if scored}
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true"></span>
        {trace.score_count} score{trace.score_count === 1 ? '' : 's'}
      </span>
    {/if}
  </div>
{/if}
