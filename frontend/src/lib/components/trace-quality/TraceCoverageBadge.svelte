<script lang="ts">
  import { Badge } from '../ui';
  import type { TraceQualityTrace } from '../../api/client';

  interface Props {
    trace: TraceQualityTrace;
    /** Compact rows (list view) show only the headline transcript + score state. */
    compact?: boolean;
  }

  let { trace, compact = false }: Props = $props();

  function flag(key: string): boolean {
    return trace.coverage[key] === true;
  }

  const hasFullTranscript = $derived(flag('has_full_transcript'));
  const hasTools = $derived(flag('has_tool_details'));
  const hasUsage = $derived(flag('has_token_usage'));
  const hasCost = $derived(flag('has_cost'));
  const scored = $derived(trace.score_count > 0);
</script>

<div class="flex flex-wrap items-center gap-1">
  {#if hasFullTranscript}
    <Badge tone="ok" title="Full transcript was available to the projection">Full transcript</Badge>
  {:else}
    <Badge tone="warn" title="Projected from partial / summary-only source data">Summary only</Badge>
  {/if}

  {#if !compact}
    {#if hasTools}<Badge tone="accent" title="Tool call details captured">Tools</Badge>{/if}
    {#if hasUsage}<Badge tone="accent" title="Token usage captured">Usage</Badge>{/if}
    {#if hasCost}<Badge tone="accent" title="Cost resolved">Cost</Badge>{/if}
  {/if}

  {#if scored}
    <Badge tone="ok" title={`${trace.score_count} local score${trace.score_count === 1 ? '' : 's'}`}>
      Scored
    </Badge>
  {:else}
    <Badge tone="neutral" title="No local review scores yet">Unscored</Badge>
  {/if}
</div>
