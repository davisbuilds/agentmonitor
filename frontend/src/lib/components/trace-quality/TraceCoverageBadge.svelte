<script lang="ts">
  import type { TraceQualityTrace } from '../../api/client';

  interface Props {
    trace: TraceQualityTrace;
    /** List rows show only a score; the detail view lists what was captured. */
    compact?: boolean;
  }

  let { trace, compact = false }: Props = $props();

  function flag(key: string): boolean {
    return trace.coverage[key] === true;
  }

  const hasFullTranscript = $derived(flag('has_full_transcript'));
  const captured = $derived([
    { label: 'Tool calls', on: flag('has_tool_details') },
    { label: 'Token usage', on: flag('has_token_usage') },
    { label: 'Cost', on: flag('has_cost') },
  ]);
  const scored = $derived(trace.score_count > 0);
</script>

<!-- The transcript flag is set only where the projection could see the
     transcript; most summaries leave it unset even when one exists, so its
     absence is not shown as "summary only". -->
{#if compact}
  {#if scored}
    <div class="mt-1.5 inline-flex items-center gap-1.5 text-meta text-text-faint">
      <span class="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true"></span>Scored
    </div>
  {/if}
{:else}
  <div class="flex flex-wrap items-center gap-3 text-meta text-text-muted">
    {#if hasFullTranscript}
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true"></span>Full transcript
      </span>
    {/if}
    {#each captured as item (item.label)}
      <span class="inline-flex items-center gap-1.5 {item.on ? '' : 'text-text-faint'}">
        <span class="h-1.5 w-1.5 rounded-full {item.on ? 'bg-ok' : 'bg-line-strong'}" aria-hidden="true"></span>
        {item.label}{item.on ? '' : ' missing'}
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
