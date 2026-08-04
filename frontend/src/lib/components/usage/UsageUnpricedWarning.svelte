<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatNumber } from '../../format';
  import { summarizeIncompleteCostUsage } from './unpriced-usage';

  const summary = $derived(summarizeIncompleteCostUsage(usage.models));
  const warningMessage = $derived.by(() => {
    if (!summary) return '';
    if (summary.unknown_pricing_model_count > 0 && summary.unrecalculated_model_count > 0) {
      return 'Some model pricing is unknown, and some historical costs have not been recalculated. Cost totals may be incomplete.';
    }
    if (summary.unknown_pricing_model_count > 0) {
      return 'Model pricing is unknown. Cost totals may be incomplete until prices are added.';
    }
    return 'Known model pricing has not been applied to some historical usage. Cost totals may be incomplete until you run amon costs recalc.';
  });
  const modelPreview = $derived.by(() => {
    if (!summary) return '';
    const names = summary.models.slice(0, 3).join(', ');
    const remaining = summary.models.length - 3;
    return remaining > 0 ? `${names} +${remaining} more` : names;
  });
</script>

{#if summary}
  <div class="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-meta text-text-muted" role="status">
    <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
    <div>
      <p class="text-text">{warningMessage}</p>
      <p class="mt-1">
        {formatNumber(summary.observed_tokens)} observed tokens across {formatNumber(summary.usage_events)} usage events from {formatNumber(summary.model_count)} model{summary.model_count === 1 ? '' : 's'}: <span class="font-mono text-text">{modelPreview}</span>
      </p>
    </div>
  </div>
{/if}
